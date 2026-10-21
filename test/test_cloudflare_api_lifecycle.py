"""Regression cases from the real API attempt; all account data here is synthetic."""
import copy
import io
import json
import os
from pathlib import Path
import sys
import unittest
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_cloudflare_provision import Account, MemoryJournal, SECRET, config
from test_cloudflare_setup import Response
import cloudflare_provision as cp
import cloudflare_setup as cf

# The same test can run against a private, isolated pre-fix module snapshot.
if os.environ.get('CF_REGRESSION_MODULES'):
    import importlib.util
    root = Path(os.environ['CF_REGRESSION_MODULES'])
    for name in ['cloudflare_setup', 'cloudflare_provision']:
        spec = importlib.util.spec_from_file_location(name, root / (name + '.py'))
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    cf, cp = sys.modules['cloudflare_setup'], sys.modules['cloudflare_provision']
    import test_cloudflare_provision as fixture
    fixture.cf, fixture.cp = cf, cp


class ApiOnlyAccount(Account):
    def change(self, method, path, body=None):
        result = super().change(method, path, body)
        if method == 'POST' and path.endswith('/mcp/portals'):
            # Observed API behavior: the portal exists but no derived app appears.
            self.remote.pop(self.auto_app)
            self.auto_app = None
        return result


class PageResponses:
    def __init__(self, bodies):
        self.bodies, self.pages = bodies, []
    def open(self, request, timeout):
        page = int(parse_qs(urlsplit(request.full_url).query)['page'][0])
        self.pages.append(page)
        body = self.bodies[page - 1]
        if isinstance(body, Exception):
            raise body
        return Response(request.full_url, json.dumps({'success': True, **body}).encode())


class ApiLifecycle(unittest.TestCase):
    def test_pagination_metadata_and_second_page_errors_never_prove_absence(self):
        first = {'result': [{'id': 'a'}], 'result_info': {'page': 1, 'per_page': 1, 'total_count': 2}}
        last = {'result': [{'id': 'b'}], 'result_info': {'page': 2, 'per_page': 1, 'total_count': 2}}
        bad = [
            {**last, 'result_info': {'page': 1, 'per_page': 1, 'total_count': 2}},
            {**last, 'result_info': {'page': 2, 'per_page': 2, 'total_count': 2}},
            {**last, 'result_info': {'page': 2, 'per_page': 1, 'total_count': 3}},
            {**last, 'result_info': {'page': 2, 'per_page': 1, 'total_count': 2, 'total_pages': 1}},
            {**last, 'result_info': False},
            {**last, 'result': []}, {**last, 'result': [{'id': 'a'}]},
            HTTPError('https://api.cloudflare.com', 403, 'denied', {}, io.BytesIO()),
        ]
        for second in bad:
            with self.subTest(second=type(second).__name__):
                api = cf.CloudflareApi(SECRET, PageResponses([first, second]))
                with self.assertRaises(cf.ApiFailure):
                    api.listing('/accounts/test/access/apps')
        pages = PageResponses([first, last])
        self.assertEqual(cf.CloudflareApi(SECRET, pages).listing('/accounts/test/access/apps'),
                         [{'id': 'a'}, {'id': 'b'}])
        for info in [{'total_pages': 0}, {'page': 1, 'per_page': 1, 'total_count': 2, 'total_pages': 1}]:
            with self.subTest(info=info), self.assertRaises(cf.ApiFailure):
                cf.CloudflareApi(SECRET, PageResponses([{'result': [{'id': 'a'}], 'result_info': info}])).listing('/accounts/test/access/apps')

    def test_actual_paginated_transport_preserves_unknown_cleanup_intent(self):
        for second_error in [False, True]:
            with self.subTest(second_error=second_error):
                journal = MemoryJournal()
                api = Account(journal)
                cp.provision(config(), api, journal, SECRET)
                resource = journal.state['resources'][-1]
                base = cp.resource_path(config(), resource).rsplit('/', 1)[0]
                first = {'result': [{'id': 'foreign'}], 'result_info': {'page': 1, 'per_page': 1, 'total_count': 2}}
                last = {'result': [{'id': resource['id']}], 'result_info': {'page': 2, 'per_page': 1, 'total_count': 2}}
                if second_error:
                    last = HTTPError('https://api.cloudflare.com', 500, 'unavailable', {}, io.BytesIO())
                pages = PageResponses([first, last])
                transport = cf.CloudflareApi(SECRET, pages)
                original_change, original_list = api.change, api.listing
                deleted = False
                def change(method, path, body=None):
                    nonlocal deleted
                    result = original_change(method, path, body)
                    if method == 'DELETE':
                        deleted = True
                        raise cf.ApiFailure('synthetic unknown DELETE', uncertain=True)
                    return result
                def listing(path, query=None):
                    if deleted and path == base:
                        return transport.listing(path, query)
                    return original_list(path, query)
                api.change, api.listing = change, listing
                with self.assertRaises(cp.ProvisionFailure):
                    cp.cleanup(api, journal)
                self.assertEqual(pages.pages, [1, 2])
                self.assertTrue(journal.snapshots[-1]['uncertain'])
                self.assertEqual(journal.snapshots[-1]['intent'], {'kind': resource['kind'], 'method': 'DELETE'})
                self.assertEqual(sum(method == 'DELETE' for method, _, _ in api.writes), 1)

    def test_foreign_app_on_second_page_blocks_initial_cleanup_delete(self):
        journal = MemoryJournal()
        api = Account(journal)
        cp.provision(config(), api, journal, SECRET)
        before = copy.deepcopy(api.writes)
        own = next(x for x in journal.state['resources'] if x['kind'] == 'portal-access')['guard']
        pages = PageResponses([
            {'result': [own], 'result_info': {'page': 1, 'per_page': 1, 'total_count': 2}},
            {'result': [{'id': 'f' * 32, 'domain': '*.example.test'}],
             'result_info': {'page': 2, 'per_page': 1, 'total_count': 2}},
        ])
        api.listing = cf.CloudflareApi(SECRET, pages).listing
        with self.assertRaises(cp.ProvisionFailure):
            cp.cleanup(api, journal)
        self.assertEqual(api.writes, before)

    def test_portal_discovery_reads_the_second_page_before_create_or_adoption(self):
        for foreign in [False, True]:
            with self.subTest(foreign=foreign):
                journal = MemoryJournal()
                api = Account(journal)
                identifier = 'f' * 32
                app = {'id': identifier, 'type': 'mcp_portal', 'domain': 'mcp.example.test', 'policies': []}
                if foreign:
                    app.update(type='self_hosted', domain='*.example.test')
                api.remote[api.app_base + '/' + identifier] = app
                pages = PageResponses([
                    {'result': [{'id': 'a' * 32, 'domain': 'unrelated.test'}],
                     'result_info': {'page': 1, 'per_page': 1, 'total_count': 2}},
                    {'result': [app], 'result_info': {'page': 2, 'per_page': 1, 'total_count': 2}},
                ])
                api.listing = cf.CloudflareApi(SECRET, pages).listing
                if foreign:
                    with self.assertRaises(cp.ProvisionFailure):
                        cp.portal_app(config(), api, set())
                else:
                    self.assertEqual(cp.portal_app(config(), api, set())['id'], identifier)
                self.assertEqual(pages.pages, [1, 2])
                self.assertEqual(api.writes, [])

    def test_later_page_target_cannot_be_reported_as_deleted(self):
        journal = MemoryJournal()
        account = Account(journal)
        cp.provision(config(), account, journal, SECRET)
        resource = next(x for x in journal.state['resources'] if x['kind'] == 'admin-access')
        path = cp.resource_path(config(), resource)
        class Pages:
            def __init__(self):
                self.pages = []
            def open(self, request, timeout):
                if urlsplit(request.full_url).path.endswith(path):
                    raise HTTPError(request.full_url, 404, 'not found', {}, io.BytesIO())
                page = int(parse_qs(urlsplit(request.full_url).query)['page'][0])
                self.pages.append(page)
                rows = [{'id': 'f' * 32}] if page == 1 else [{'id': resource['id']}]
                body = {'success': True, 'result': rows,
                        'result_info': {'page': page, 'per_page': 1, 'total_count': 2}}
                return Response(request.full_url, json.dumps(body).encode())
        pages = Pages()
        self.assertFalse(cp.deletion_confirmed(config(), cf.CloudflareApi(SECRET, pages), resource),
                         'A target on page two is still present, even when page one is shorter than requested')
        self.assertEqual(pages.pages, [1, 2])

    def test_portal_without_derived_app_creates_explicit_owner_oauth_app(self):
        journal = MemoryJournal()
        api = ApiOnlyAccount(journal)
        self.assertEqual(cp.provision(config(), api, journal, SECRET)['status'],
                         'RESOURCES_CREATED_CONNECTION_REQUIRED')
        app = next(x for x in journal.state['resources'] if x['kind'] == 'portal-access')
        current = api.remote[cp.resource_path(config(), app)]
        self.assertEqual(current['policies'][0]['include'], [{'email': {'email': 'owner@example.test'}}])
        self.assertEqual(current['oauth_configuration']['dynamic_client_registration']['allowed_uris'],
                         ['https://client.example.test/callback'])
        self.assertEqual(sum(method == 'POST' and body.get('type') == 'mcp_portal'
                             for method, _, body in api.writes if body), 1)
        self.assertEqual(cp.cleanup(api, journal)['status'], 'CLEANED')

    def test_successful_portal_is_durable_before_discovery_failure(self):
        journal = MemoryJournal()
        api = ApiOnlyAccount(journal)
        original = api.listing
        def discover(path, query=None):
            if api.auto_app is None and any(k.endswith('/mcp/portals/new-install') for k in api.remote):
                saved = journal.snapshots[-1]
                self.assertIsNone(saved['intent'], 'Successful portal identity must close only its POST intent')
                self.assertTrue(any(x['kind'] == 'mcp-portal' and x['id'] == 'new-install'
                                    for x in saved['resources']), 'Known portal identity must survive a read failure')
                raise cf.ApiFailure('synthetic read unavailable')
            return original(path, query)
        api.listing = discover
        with self.assertRaises(cf.ApiFailure):
            cp.provision(config(), api, journal, SECRET)

    def test_definite_failure_at_every_explicit_write_preserves_cleanup(self):
        count = len(cf.connection_plan(config())['plannedResources'])
        for point in range(1, count + 1):
            with self.subTest(point=point):
                journal = MemoryJournal()
                api = ApiOnlyAccount(journal, fail_at=point)
                with self.assertRaises(cp.ProvisionFailure):
                    cp.provision(config(), api, journal, SECRET)
                self.assertFalse(journal.state['uncertain'])
                self.assertIsNone(journal.state['intent'])
                api.fail_at = None
                self.assertEqual(cp.cleanup(api, journal)['status'], 'CLEANED')

    def test_uncertain_delete_resolves_once_only_after_terminal_reads(self):
        journal = MemoryJournal()
        api = Account(journal)
        cp.provision(config(), api, journal, SECRET)
        original = api.change
        def uncertain(method, path, body=None):
            result = original(method, path, body)
            if method == 'DELETE':
                raise cf.ApiFailure('synthetic lost acknowledgement', uncertain=True)
            return result
        api.change = uncertain
        self.assertEqual(cp.cleanup(api, journal)['status'], 'CLEANED')
        deletes = [path for method, path, _ in api.writes if method == 'DELETE']
        self.assertEqual(len(deletes), len(set(deletes)), 'A missing acknowledgement never authorizes a retry')

    def test_failed_terminal_read_preserves_original_uncertainty(self):
        for mode in ['get403', 'get500', 'list403', 'listed', 'present']:
            with self.subTest(mode=mode):
                journal = MemoryJournal()
                api = Account(journal)
                cp.provision(config(), api, journal, SECRET)
                resource = copy.deepcopy(journal.state['resources'][-1])
                path = cp.resource_path(config(), resource)
                original, get, listing = api.change, api.get, api.listing
                failed = False
                def uncertain(method, target, body=None):
                    nonlocal failed
                    result = original(method, target, body)
                    if method == 'DELETE':
                        failed = True
                        if mode == 'present':
                            api.remote[target] = copy.deepcopy(resource['guard'])
                        raise cf.ApiFailure('synthetic unknown acknowledgement', uncertain=True)
                    return result
                def terminal_get(target, query=None):
                    if failed and mode.startswith('get'):
                        raise cf.ApiFailure('Cloudflare 요청 실패: HTTP ' + mode[3:] + '.')
                    return get(target, query)
                def terminal_list(target, query=None):
                    if failed and mode == 'list403':
                        raise cf.ApiFailure('Cloudflare 요청 실패: HTTP 403.')
                    if failed and mode == 'listed' and target == path.rsplit('/', 1)[0]:
                        return [copy.deepcopy(resource['guard'])]
                    return listing(target, query)
                api.change, api.get, api.listing = uncertain, terminal_get, terminal_list
                with self.assertRaises(cp.ProvisionFailure):
                    cp.cleanup(api, journal)
                self.assertTrue(journal.snapshots[-1]['uncertain'])
                self.assertEqual(journal.snapshots[-1]['intent'], {'kind': resource['kind'], 'method': 'DELETE'})
                self.assertEqual(sum(method == 'DELETE' for method, _, _ in api.writes), 1)

    def test_uncertain_explicit_app_creation_is_not_replayed_or_deleted(self):
        journal = MemoryJournal()
        api = ApiOnlyAccount(journal)
        original = api.change
        def uncertain(method, path, body=None):
            result = original(method, path, body)
            if method == 'POST' and body.get('type') == 'mcp_portal':
                raise cf.ApiFailure('synthetic lost creation acknowledgement', uncertain=True)
            return result
        api.change = uncertain
        with self.assertRaises(cp.ProvisionFailure):
            cp.provision(config(), api, journal, SECRET)
        before = copy.deepcopy(api.writes)
        self.assertEqual(journal.snapshots[-1]['intent'], {'kind': 'portal-access', 'method': 'POST'})
        with self.assertRaises(cp.ProvisionFailure):
            cp.cleanup(api, journal)
        with self.assertRaises(cp.ProvisionFailure):
            cp.provision(config(), api, journal, SECRET)
        self.assertEqual(api.writes, before)

    def test_portal_discovery_rejects_foreign_or_ambiguous_apps(self):
        for additions in [[{'type': 'self_hosted', 'domain': '*.example.test'}],
                          [{'type': 'self_hosted', 'destinations': [{'type': 'public', 'uri': 'mcp.example.test'}]}],
                          [{'type': 'mcp_portal', 'domain': 'mcp.example.test', 'policies': []}] * 2]:
            with self.subTest(additions=additions):
                journal = MemoryJournal()
                api = ApiOnlyAccount(journal)
                original = api.change
                def inject(method, path, body=None):
                    result = original(method, path, body)
                    if method == 'POST' and path.endswith('/mcp/portals'):
                        for i, item in enumerate(additions):
                            identifier = str(i + 7) * 32
                            api.remote[api.app_base + '/' + identifier] = {'id': identifier, **item}
                    return result
                api.change = inject
                with self.assertRaises(cp.ProvisionFailure):
                    cp.provision(config(), api, journal, SECRET)
                self.assertTrue(any(x['kind'] == 'mcp-portal' for x in journal.snapshots[-1]['resources']))
                self.assertIsNone(journal.snapshots[-1]['intent'])
                self.assertFalse(any(method == 'POST' and body.get('type') == 'mcp_portal'
                                     for method, _, body in api.writes if body))

    def test_deleted_tunnel_requires_valid_tombstone_and_empty_dedicated_clients(self):
        for change in [{}, {'deleted_at': 'bad'}, {'deleted_at': '2999-01-01T00:00:00Z'},
                       {'deleted_at': '2026-01-01T00:00:00'}, {'status': 'healthy'}]:
            with self.subTest(change=change):
                journal = MemoryJournal()
                api = Account(journal)
                cp.provision(config(), api, journal, SECRET)
                resource = next(x for x in journal.state['resources'] if x['kind'] == 'tunnel')
                target = cp.resource_path(config(), resource)
                original_get, original_list = api.get, api.listing
                def tombstone(path, query=None):
                    if path == target:
                        return {'result': {**resource['guard'], 'status': 'down',
                                           'deleted_at': '2026-01-01T00:00:00Z', **change}}
                    return original_get(path, query)
                api.get = tombstone
                api.listing = lambda path, query=None: [x for x in original_list(path, query)
                                                        if x.get('id') != resource['id']]
                self.assertEqual(cp.deletion_confirmed(config(), api, resource), not bool(change))
                api.clients = [{'id': '1' * 8 + '-1111-1111-1111-' + '1' * 12, 'conns': []}]
                self.assertFalse(cp.deletion_confirmed(config(), api, resource))

    def test_new_overlapping_app_blocks_cleanup_without_any_delete(self):
        for shape in [{'domain': '*.example.test'}, {'domain': 'mcp.example.test'},
                      {'destinations': [{'type': 'public', 'uri': 'https://mcp.example.test/path'}]}]:
            with self.subTest(shape=shape):
                journal = MemoryJournal()
                api = Account(journal)
                cp.provision(config(), api, journal, SECRET)
                api.remote[api.app_base + '/' + 'f' * 32] = {'id': 'f' * 32, 'type': 'self_hosted', **shape}
                before = copy.deepcopy(api.writes)
                with self.assertRaises(cp.ProvisionFailure):
                    cp.cleanup(api, journal)
                self.assertEqual(api.writes, before)


if __name__ == '__main__':
    unittest.main()
