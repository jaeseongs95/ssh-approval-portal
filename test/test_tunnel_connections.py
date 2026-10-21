"""Dedicated API contract fixtures; no real Cloudflare/network/service is used."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import cloudflare_provision as cp
import cloudflare_setup as cf
from test_cloudflare_provision import Account, MemoryJournal, SECRET, config

CLIENT = {'id': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'conns': [{'id': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}]}


def page(rows, number=1, total=None, size=100):
    return {'result': copy.deepcopy(rows), 'result_info': {'page': number, 'per_page': size, 'total_count': len(rows) if total is None else total}}


class Pages:
    def __init__(self, responses):
        self.responses, self.calls = responses, []
    def get(self, path, query=None):
        self.calls.append((path, query))
        response = self.responses[len(self.calls) - 1]
        if isinstance(response, Exception):
            raise response
        return copy.deepcopy(response)


class DedicatedConnections(unittest.TestCase):
    resource = {'kind': 'tunnel', 'id': '1' * 32}
    def clients(self, responses):
        return cp.tunnel_clients(config(), Pages(responses), self.resource)
    def test_complete_empty_and_actual_connection_are_distinct(self):
        self.assertEqual(self.clients([page([])]), [])
        self.assertEqual(self.clients([{'result': []}]), [])
        self.assertEqual(self.clients([{'result': [CLIENT]}]), [CLIENT])
        self.assertEqual(self.clients([page([CLIENT])]), [CLIENT])
        self.assertFalse(any(x['conns'] for x in self.clients([page([dict(CLIENT, conns=[])])])) )
    def test_all_pages_are_required_before_deciding_no_connections(self):
        empty_client = dict(CLIENT, id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', conns=[])
        api = Pages([page([empty_client], total=2, size=1), page([CLIENT], number=2, total=2, size=1)])
        self.assertTrue(any(x['conns'] for x in cp.tunnel_clients(config(), api, self.resource)))
        self.assertEqual([None if query is None else query['page'] for _, query in api.calls], [None, 2])
    def test_missing_inconsistent_duplicate_or_early_empty_page_is_unknown(self):
        invalid = [
            [{'result': [], 'result_info': None}], [{'result': None, 'result_info': page([])['result_info']}],
            [page([], total=1)], [page([CLIENT], total=2, size=1), page([], number=2, total=2, size=1)],
            [page([CLIENT], total=2, size=1), page([CLIENT], number=2, total=2, size=1)],
            [page([CLIENT], total=2, size=1), page([], number=2, total=3, size=1)],
            [page([CLIENT], number=2)], [page([dict(CLIENT, conns=None)])],
            [page([dict(CLIENT, conns=[{}])])], [page([dict(conns=[])])],
            [{'result': [], 'result_info': {'page': True, 'per_page': 100, 'total_count': 0}}],
        ]
        for response in invalid:
            with self.subTest(response=response), self.assertRaises(cp.ProvisionFailure):
                self.clients(response)
    def test_connection_read_errors_are_never_absence(self):
        for error in [cf.ApiFailure('Cloudflare 요청 실패: HTTP 403.'), cf.ApiFailure('Cloudflare 요청 실패: HTTP 404.'), cf.ApiFailure('Cloudflare 요청 실패: HTTP 500.'), TimeoutError()]:
            with self.subTest(error=type(error).__name__), self.assertRaises(type(error)):
                self.clients([error])
    def test_uuid_format_must_be_complete_for_clients_and_connections(self):
        for invalid in ['-' * 32, 'a' * 33, 'a' * 32, 'g' * 36, 'cccccccc-cccc-4ccc-8ccc-ccccccccccc']:
            for client in [dict(CLIENT, id=invalid), dict(CLIENT, conns=[{'id': invalid}])]:
                with self.subTest(invalid=invalid, field='id' if client['id'] == invalid else 'conns'), self.assertRaises(cp.ProvisionFailure):
                    self.clients([page([client])])
    def test_count_contradiction_never_confirms_empty_connections(self):
        for count in [1, -1, True, '0']:
            response = page([])
            response['result_info']['count'] = count
            with self.subTest(count=count), self.assertRaises(cp.ProvisionFailure):
                self.clients([response])
        response = page([CLIENT])
        response['result_info']['count'] = 1
        self.assertEqual(self.clients([response]), [CLIENT])
    def test_cleanup_refuses_dedicated_client_when_deprecated_field_is_empty(self):
        journal, api = MemoryJournal(), None
        api = Account(journal)
        cp.provision(config(), api, journal, SECRET)
        api.clients = [CLIENT]
        before = copy.deepcopy(api.writes)
        with self.assertRaisesRegex(cp.ProvisionFailure, 'TUNNEL_IN_USE'):
            cp.cleanup(api, journal)
        self.assertEqual(api.writes, before)
    def test_old_guard_connections_are_ephemeral_but_other_changes_still_refused(self):
        journal = MemoryJournal()
        api = Account(journal)
        cp.provision(config(), api, journal, SECRET)
        tunnel = next(x for x in journal.state['resources'] if x['kind'] == 'tunnel')
        tunnel['guard']['connections'] = [{'id': 'stale-old-observation'}]
        path = cp.resource_path(config(), tunnel)
        api.remote[path]['connections'] = []
        self.assertTrue(cp.verify_resource(config(), api, tunnel))
        api.remote[path]['unknown_security_setting'] = True
        with self.assertRaisesRegex(cp.ProvisionFailure, 'RESOURCE_CHANGED'):
            cp.verify_resource(config(), api, tunnel)
    def test_cleanup_read_failure_sends_no_delete(self):
        for response in [page([], total=1), {'result': [], 'result_info': None}, cf.ApiFailure('denied')]:
            journal = MemoryJournal()
            api = Account(journal)
            cp.provision(config(), api, journal, SECRET)
            original = api.get
            def get(path, query=None):
                if path.endswith('/connections'):
                    if isinstance(response, Exception):
                        raise response
                    return response
                return original(path, query)
            api.get = get
            before = copy.deepcopy(api.writes)
            with self.assertRaises(Exception):
                cp.cleanup(api, journal)
            self.assertEqual(api.writes, before)


if __name__ == '__main__':
    unittest.main()
