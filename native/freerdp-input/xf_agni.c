/* SPDX-License-Identifier: Apache-2.0 */
#include "xf_agni.h"
#include "agni_build.h"
#include <errno.h>
#include <fcntl.h>
#include <freerdp/config.h>
#include <freerdp/input.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>

static int guard(void *user, uint8_t kind)
{
    xfContext *xfc = user;
    rdpContext *c = &xfc->common.context;
    rdpInput *in = c->input;
    if (!freerdp_is_active_state(c) || freerdp_shall_disconnect_context(c))
        return 10;
    if (freerdp_settings_get_bool(c->settings, FreeRDP_SuspendInput))
        return 11;
    if (!in)
        return 12;
    switch (kind)
    {
    case AGNI_SCAN:
        return in->KeyboardEvent ? 0 : 12;
    case AGNI_UNICODE:
        if (!freerdp_settings_get_bool(c->settings, FreeRDP_UnicodeInput))
            return 20;
        return in->UnicodeKeyboardEvent ? 0 : 12;
    case AGNI_MOUSE:
        return in->MouseEvent ? 0 : 12;
    case AGNI_EXT_MOUSE:
        if (!freerdp_settings_get_bool(c->settings, FreeRDP_HasExtendedMouseEvent))
            return 9;
        return in->ExtendedMouseEvent ? 0 : 12;
    default:
        return 17;
    }
}
static bool sender(void *user, const agni_event *e)
{
    xfContext *xfc = user;
    rdpInput *in = xfc->common.context.input;
    /* Called only by the main RDP loop after guard, not the skip-TRUE wrappers. */
    switch (e->kind)
    {
    case AGNI_SCAN:
    {
        UINT16 flags = (e->code & 0x100) ? KBD_FLAGS_EXTENDED : 0;
        if (!e->down)
            flags |= KBD_FLAGS_RELEASE;
        return in->KeyboardEvent(in, flags, (UINT8)(e->code & 0xff)) != FALSE;
    }
    case AGNI_UNICODE:
        return in->UnicodeKeyboardEvent(in, e->down ? 0 : KBD_FLAGS_RELEASE, e->code) != FALSE;
    case AGNI_MOUSE:
        return in->MouseEvent(in, e->code, e->x, e->y) != FALSE;
    case AGNI_EXT_MOUSE:
        return in->ExtendedMouseEvent(in, e->code, e->x, e->y) != FALSE;
    default:
        return false;
    }
}
static uint32_t mapping(void *user, uint32_t key) { return xf_agni_map_key(user, key); }
static bool geometry(void *user, uint16_t x, uint16_t y)
{
    xfContext *f = user;
    rdpSettings *s = f->common.context.settings;
    return x < freerdp_settings_get_uint32(s, FreeRDP_DesktopWidth) &&
           y < freerdp_settings_get_uint32(s, FreeRDP_DesktopHeight);
}
static bool pointer_cap(void *user, uint8_t buttons)
{
    xfContext *f = user;
    rdpSettings *s = f->common.context.settings;
    if ((buttons & 0x80) && !freerdp_settings_get_bool(s, FreeRDP_HasExtendedMouseEvent))
        return false;
    if ((buttons & 0x18) && !freerdp_settings_get_bool(s, FreeRDP_MouseHasWheel))
        return false; /* Horizontal wheel has no negotiated capability in this version; fail closed.
                       */
    return (buttons & 0x60) == 0;
}
agni *xf_agni_new(xfContext *xfc)
{
    static const uint8_t digest[32] = {AGNI_PATCH_BYTES};
    const agni_ops ops = {.user = xfc,
                          .guard = guard,
                          .send = sender,
                          .map_key = mapping,
                          .geometry = geometry,
                          .pointer_supported = pointer_cap};
    return agni_new(xfc->ags_fd, &ops, digest);
}
int xf_agni_option(int *argc, char **argv)
{
    int fd = 0;
    for (int i = 1; i < *argc; i++)
        if (strncmp(argv[i], "/ags-input-fd:", 14) == 0)
        {
            if (fd)
                return -1;
            const char *p = argv[i] + 14;
            if (!*p)
                return -1;
            for (const char *k = p; *k; k++)
                if (*k < '0' || *k > '9')
                    return -1;
            errno = 0;
            char *end = NULL;
            long v = strtol(p, &end, 10);
            if (errno || *end || v < 3 || v > 1048575)
                return -1;
            fd = (int)v;
            int type = 0;
            socklen_t len = sizeof(type);
            struct sockaddr_storage sa;
            socklen_t slen = sizeof(sa);
            if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &len) || type != SOCK_STREAM ||
                getpeername(fd, (struct sockaddr *)&sa, &slen) || sa.ss_family != AF_UNIX)
                return -1;
            int flags = fcntl(fd, F_GETFD);
            if (flags < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) < 0)
                return -1;
            memmove(argv + i, argv + i + 1, (size_t)(*argc - i) * sizeof(char *));
            (*argc)--;
            i--;
        }
    return fd;
}
void xf_agni_capabilities(void)
{
    puts("{\"protocol\":\"ags-native-input/"
         "1\",\"upstreamCommit\":\"bf217a504e54cc719880c228e82353382cd7d4fa\",\"patchDigest\":"
         "\"" AGNI_PATCH_HEX "\"}");
}
