#!/usr/bin/env python3
"""Create and apply the deterministic, pinned X11-only source patch."""
import difflib
import hashlib
import pathlib
import sys

PIN = 'bf217a504e54cc719880c228e82353382cd7d4fa'

def apply(source, output):
    source, output = pathlib.Path(source), pathlib.Path(output)
    overlay = pathlib.Path(__file__).parent
    changed = {}
    def edit(name, old, new):
        before, current = changed.get(name, (None, None))
        if before is None:
            before = (source / name).read_text(encoding='utf-8')
            current = before
        if current.count(old) != 1:
            raise RuntimeError('pinned source anchor mismatch: ' + name)
        changed[name] = (before, current.replace(old, new, 1))
    for name in ('agni.h', 'agni.c', 'xf_agni.h', 'xf_agni.c'):
        changed['client/X11/' + name] = ('', (overlay / name).read_text(encoding='utf-8'))
    edit('client/X11/CMakeLists.txt', '    xf_client.c\n', '    agni.c\n    agni.h\n    xf_agni.c\n    xf_agni.h\n    xf_client.c\n')
    edit('client/X11/xfreerdp.h', '\trdpClientContext common;\n', '\trdpClientContext common;\n\tint ags_fd; /* Private inherited native-input fd; zero means stock. */\n')
    edit('client/X11/cli/xfreerdp.c', '#include "../xf_client.h"', '#include "../xf_agni.h"\n#include "../xf_client.h"')
    edit('client/X11/cli/xfreerdp.c', '\tint rc = 1;\n', '\tif ((argc == 2) && (strcmp(argv[1], "/ags-input-capabilities") == 0))\n\t{ xf_agni_capabilities(); return 0; }\n\tconst int ags_fd = xf_agni_option(&argc, argv);\n\tif (ags_fd < 0) return 1;\n\tint rc = 1;\n')
    edit('client/X11/cli/xfreerdp.c', '\txfc = (xfContext*)context;\n', '\txfc = (xfContext*)context;\n\txfc->ags_fd = ags_fd;\n')
    edit('client/X11/cli/xfreerdp.c', '\tif (!stream_dump_register_handlers', '''\tif (ags_fd)
    {
        /* A single private input source; reject parallel injection/replay modes. */
        if (freerdp_settings_get_string(settings, FreeRDP_KeyboardPipeName) ||
            freerdp_settings_get_bool(settings, FreeRDP_RemoteApplicationMode)) goto out;
        if (!freerdp_settings_set_bool(settings, FreeRDP_AutoReconnectionEnabled, FALSE) ||
            !freerdp_settings_set_bool(settings, FreeRDP_RedirectClipboard, FALSE)) goto out;
    }
\tif (!stream_dump_register_handlers''')
    edit('client/X11/xf_client.c', '#include "xf_reconnect.h"', '#include "xf_reconnect.h"\n#include "xf_agni.h"')
    edit('client/X11/xf_client.c', '\tHANDLE inputEvent = nullptr;\n', '\tHANDLE inputEvent = nullptr;\n\tHANDLE ags_event = nullptr;\n\tagni* ags = nullptr;\n')
    edit('client/X11/xf_client.c', '\tinputEvent = xfc->x11event;\n', '''\tinputEvent = xfc->x11event;
    if (xfc->ags_fd)
    {
        ags = xf_agni_new(xfc);
        if (!ags) { exit_code = XF_EXIT_UNKNOWN; goto disconnect; }
        ags_event = CreateFileDescriptorEvent(nullptr, FALSE, FALSE, xfc->ags_fd, WINPR_FD_READ);
        if (!ags_event) { exit_code = XF_EXIT_UNKNOWN; goto disconnect; }
    }
''')
    edit('client/X11/xf_client.c', '\t\thandles[nCount++] = inputEvent;\n', '\t\thandles[nCount++] = inputEvent;\n\t\tif (ags_event) handles[nCount++] = ags_event;\n')
    edit('client/X11/xf_client.c', '\t\tif (freerdp_focus_required(instance))', '\t\tif (!ags && freerdp_focus_required(instance))')
    edit('client/X11/xf_client.c', '\t\twaitStatus = WaitForMultipleObjects(nCount, handles, FALSE, INFINITE);', '\t\twaitStatus = WaitForMultipleObjects(nCount, handles, FALSE, ags ? 10 : INFINITE);')
    edit('client/X11/xf_client.c', '\t\t\t\tconst BOOL reconnected = client_auto_reconnect_ex', '\t\t\t\tif (ags) break; /* Never replay credentials or input on reconnect. */\n\t\t\t\tconst BOOL reconnected = client_auto_reconnect_ex')
    edit('client/X11/xf_client.c', '\t\tif (!handle_window_events(instance))\n\t\t\tbreak;\n', '\t\tif (!handle_window_events(instance))\n\t\t\tbreak;\n\t\tif (ags && !agni_pump(ags)) break;\n')
    edit('client/X11/xf_client.c', 'disconnect:\n\n\tfreerdp_disconnect(instance);', 'disconnect:\n\tif (ags_event) CloseHandle(ags_event);\n\tif (ags) agni_free(ags);\n\tfreerdp_disconnect(instance);')
    edit('client/X11/xf_event.c', '\tif (!xf_reconnect_event(xfc, event))', '''\tif (xfc->ags_fd)
    {
        /* Rendering/MappingNotify remain live; managed input has exactly one source. */
        switch (event->type)
        {
            case KeyPress: case KeyRelease: case ButtonPress: case ButtonRelease:
            case MotionNotify: case GenericEvent: case FocusIn: case FocusOut:
            case EnterNotify: case LeaveNotify: return TRUE;
            default: break;
        }
    }
\tif (!xf_reconnect_event(xfc, event))''')
    edit('client/X11/xf_keyboard.c', 'static BOOL xf_sync_kbd_state(xfContext* xfc)\n{', 'static BOOL xf_sync_kbd_state(xfContext* xfc)\n{\n\tif (xfc->ags_fd) return TRUE;')
    edit('client/X11/xf_keyboard.c', '#include "xf_keyboard.h"', '#include "xf_keyboard.h"\n#include "xf_agni.h"')
    edit('client/X11/xf_keyboard.c', 'void xf_keyboard_release_all_keypress(xfContext* xfc)\n{', 'void xf_keyboard_release_all_keypress(xfContext* xfc)\n{\n\tif (xfc->ags_fd) return;')
    edit('client/X11/xf_keyboard.c', 'void xf_keyboard_focus_in(xfContext* xfc)\n{', 'void xf_keyboard_focus_in(xfContext* xfc)\n{\n\tif (xfc->ags_fd) return;')
    name = 'client/X11/xf_keyboard.c'
    before = (source / name).read_text(encoding='utf-8')
    current = changed[name][1]
    current += '''
/* Private explicit KEY mapping. Held releases retain their original scancode in AGNI. */
uint32_t xf_agni_map_key(xfContext* xfc, uint32_t key)
{
    KeyCode code = XKeysymToKeycode(xfc->display, (KeySym)key);
    if (!code) return 0;
    return get_rdp_scancode_from_x11_keycode(xfc, code);
}
'''
    changed[name] = before, current
    patch = ''.join(''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                fromfile=('a/' + name) if before else '/dev/null', tofile='b/' + name))
                for name, (before, after) in sorted(changed.items()))
    output.write_text(patch, encoding='utf-8', newline='\n')
    digest = hashlib.sha256(patch.encode()).hexdigest()
    for name, (_, after) in changed.items():
        (source / name).write_text(after, encoding='utf-8', newline='\n')
    (source / 'client/X11/agni_build.h').write_text(
        '#define AGNI_PATCH_HEX "' + digest + '"\n#define AGNI_PATCH_BYTES ' +
        ','.join('0x' + digest[i:i+2] for i in range(0,64,2)) + '\n', encoding='ascii')
    return digest

if __name__ == '__main__':
    print(apply(sys.argv[1], sys.argv[2]))
