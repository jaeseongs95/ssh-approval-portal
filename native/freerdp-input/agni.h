/* SPDX-License-Identifier: Apache-2.0 */
#ifndef AGNI_H
#define AGNI_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define AGNI_MAX_PAYLOAD 9856
#define AGNI_MAX_CALLS 9344
enum
{
    AGNI_SCAN = 1,
    AGNI_UNICODE = 2,
    AGNI_MOUSE = 3,
    AGNI_EXT_MOUSE = 4
};
typedef struct
{
    uint8_t kind, phase, track, down;
    uint16_t code, x, y, action, element;
    uint32_t key;
} agni_event;
typedef struct
{
    void *user;
    /* Return wire error code, zero only when actual native dispatch is possible. */
    int (*guard)(void *, uint8_t);
    bool (*send)(void *, const agni_event *);
    uint32_t (*map_key)(void *, uint32_t);
    bool (*geometry)(void *, uint16_t, uint16_t);
    bool (*pointer_supported)(void *, uint8_t);
} agni_ops;
typedef struct agni agni;
agni *agni_new(int fd, const agni_ops *ops, const uint8_t patch_digest[32]);
/* Nonblocking, finite quantum; false means detach, never logoff. */
bool agni_pump(agni *a);
bool agni_busy(const agni *a);
void agni_free(agni *a);
#endif
