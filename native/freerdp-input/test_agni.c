/* SPDX-License-Identifier: Apache-2.0 */
#define _POSIX_C_SOURCE 200809L
#include "agni.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int short_io = 0, io_count = 0;
ssize_t __real_send(int, const void *, size_t, int);
ssize_t __wrap_send(int fd, const void *p, size_t n, int flags)
{
    if (short_io)
    {
        if ((++io_count % 3) == 0)
        {
            errno = EAGAIN;
            return -1;
        }
        if (n > 3)
            n = 3;
    }
    return __real_send(fd, p, n, flags);
}
typedef struct
{
    int guard_error, fail_call, guard_after;
    unsigned calls;
    agni_event events[10000];
} fixture;
static int guard(void *u, uint8_t kind)
{
    (void)kind;
    fixture *f = u;
    if (f->guard_after && f->calls >= (unsigned)f->guard_after)
        return 11;
    return f->guard_error;
}
static bool sender(void *u, const agni_event *e)
{
    fixture *f = u;
    assert(f->calls < 10000);
    f->events[f->calls++] = *e;
    return (int)f->calls != f->fail_call;
}
static uint32_t map(void *u, uint32_t k)
{
    (void)u;
    switch (k)
    {
    case 0xffeb:
        return 0x15b;
    case 0xffe3:
        return 0x1d;
    case 0xffe9:
        return 0x38;
    case 0xff0d:
        return 0x1c;
    case 'a':
    case 'A':
        return 0x1e;
    case 'r':
        return 0x13;
    default:
        return 0;
    }
}
static bool geom(void *u, uint16_t x, uint16_t y)
{
    (void)u;
    return x < 1280 && y < 800;
}
static bool pointer(void *u, uint8_t b)
{
    (void)u;
    return !(b & 0x60);
}
static void w16(uint8_t *p, uint16_t v)
{
    p[0] = v >> 8;
    p[1] = v;
}
static void w32(uint8_t *p, uint32_t v)
{
    w16(p, v >> 16);
    w16(p + 2, v);
}
static uint32_t r32(const uint8_t *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static size_t frame(uint8_t *p, uint8_t kind, uint64_t seq, const void *body, size_t n)
{
    memcpy(p, "AGNI", 4);
    p[4] = 1;
    p[5] = kind;
    w16(p + 6, 0);
    w32(p + 8, n);
    w32(p + 12, seq >> 32);
    w32(p + 16, seq);
    memcpy(p + 20, body, n);
    return n + 20;
}
static size_t tlv(uint8_t *p, uint8_t kind, const void *value, size_t n)
{
    p[0] = kind;
    memset(p + 1, 0, 3);
    w32(p + 4, n);
    memcpy(p + 8, value, n);
    return n + 8;
}
static void write_all(int fd, const void *p, size_t n)
{
    assert(__real_send(fd, p, n, MSG_NOSIGNAL) == (ssize_t)n);
}
static void read_n(agni *a, int fd, uint8_t *p, size_t n)
{
    size_t got = 0;
    for (unsigned tries = 0; tries < 20000 && got < n; tries++)
    {
        (void)agni_pump(a);
        ssize_t r = recv(fd, p + got, n - got, MSG_DONTWAIT);
        if (r > 0)
            got += (size_t)r;
        else
            assert(r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK));
    }
    assert(got == n);
}
static agni *setup(fixture *f, int *client)
{
    int sv[2];
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0);
    agni_ops ops = {f, guard, sender, map, geom, pointer};
    uint8_t digest[32];
    memset(digest, 0x42, 32);
    agni *a = agni_new(sv[0], &ops, digest);
    assert(a);
    *client = sv[1];
    uint8_t hello[108];
    read_n(a, *client, hello, sizeof(hello));
    assert(!memcmp(hello, "AGNI\1\1\0\0", 8));
    assert(r32(hello + 8) == 88);
    assert(r32(hello + 20) == 0x1f);
    assert(!memcmp(hello + 76, digest, 32));
    return a;
}
static void finish(agni *a, int client)
{
    agni_free(a);
    close(client);
}
static void request(agni *a, int fd, uint8_t kind, uint64_t seq, const uint8_t *b, size_t n,
                    uint8_t ack[44])
{
    uint8_t p[10000];
    size_t count = frame(p, kind, seq, b, n);
    write_all(fd, p, count);
    read_n(a, fd, ack, 44);
    assert(!memcmp(ack, "AGNI\1\3\0\0", 8));
    assert(r32(ack + 8) == 24);
}
static void ok(const uint8_t *ack, unsigned calls)
{
    assert(ack[20] == 0 && ack[21] == 1 && ack[22] == 0 && ack[23] == 0);
    assert(r32(ack + 24) == calls && r32(ack + 28) == calls);
    assert(ack[32] == 255 && ack[33] == 255 && ack[36] == 6);
}
static void rejected(const uint8_t *ack, unsigned code)
{
    assert(ack[20] == 1 && ack[23] == code);
    assert(r32(ack + 24) == 0 && r32(ack + 28) == 0);
}
static unsigned tests = 0;
static void partial_oracle(void)
{
    const uint8_t oracle[] = {0x41, 0x47, 0x4e, 0x49, 1, 2, 0, 0, 0, 0, 0, 9, 0, 0,   0,
                              0,    0,    0,    0,    1, 1, 0, 0, 0, 0, 0, 0, 1, 0x41};
    const uint8_t expected[] = {0x41, 0x47, 0x4e, 0x49, 1,   3,   0, 0, 0, 0, 0, 24, 0, 0, 0,
                                0,    0,    0,    0,    1,   0,   1, 0, 0, 0, 0, 0,  2, 0, 0,
                                0,    2,    255,  255,  255, 255, 6, 0, 0, 0, 0, 0,  0, 0};
    for (size_t cut = 1; cut < sizeof(oracle); cut++)
    {
        fixture f = {0};
        int c;
        agni *a = setup(&f, &c);
        write_all(c, oracle, cut);
        for (int i = 0; i < 3; i++)
            assert(agni_pump(a));
        assert(f.calls == 0);
        write_all(c, oracle + cut, sizeof(oracle) - cut);
        uint8_t ack[44];
        read_n(a, c, ack, 44);
        assert(!memcmp(ack, expected, 44));
        assert(f.calls == 2 && f.events[0].code == 0x41 && f.events[1].code == 0x41);
        finish(a, c);
        tests++;
    }
}
static void unicode_and_order(void)
{
    fixture f = {0};
    int c;
    agni *a = setup(&f, &c);
    uint8_t b[200], p[300], ack[44];
    size_t n = 0;
    const uint8_t text[] = {'A', 'a', ':', 0xed, 0x95, 0x9c, 0xf0, 0x9f, 0x98, 0x80, '\n', '\t'};
    n += tlv(b + n, 1, text, sizeof(text));
    const uint8_t key[] = {0, 0, 0xff, 0xeb, 1};
    n += tlv(b + n, 2, key, 5);
    const uint8_t pointerv[] = {0, 12, 0, 20, 3};
    n += tlv(b + n, 3, pointerv, 5);
    size_t size = frame(p, 2, 1, b, n);
    for (size_t i = 0; i < size; i++)
    {
        write_all(c, p + i, 1);
        assert(agni_pump(a));
        if (i + 1 < size)
            assert(f.calls == 0);
    }
    read_n(a, c, ack, 44);
    ok(ack, 20);
    uint16_t codes[] = {0x41, 0x61, 0x3a, 0xd55c, 0xd83d, 0xde00, 0x1c, 0x0f};
    for (unsigned i = 0; i < 8; i++)
    {
        assert(f.events[i * 2].code == codes[i]);
        assert(f.events[i * 2].down == 1 && !f.events[i * 2 + 1].down);
    }
    assert(f.events[16].kind == AGNI_SCAN && f.events[16].code == 0x15b);
    assert(f.events[17].phase == 3);
    assert(f.events[18].code == 0x9000 && f.events[19].code == 0xc000);
    uint8_t release = 1;
    n = tlv(b, 4, &release, 1);
    request(a, c, 2, 2, b, n, ack);
    ok(ack, 3);
    assert(ack[37] == 2 && ack[39] == 0 && ack[40] == 0);
    request(a, c, 4, 3, &release, 1, ack);
    ok(ack, 0);
    assert(ack[37] == 6);
    assert(!agni_pump(a));
    finish(a, c);
    tests++;
}
static void invalid_inputs(void)
{
    const uint8_t bad[][5] = {
        {0xc0, 0xaf}, {0xed, 0xa0, 0x80}, {0xf4, 0x90, 0x80, 0x80}, {0xe2, 0x82}, {0x80}, {0, 0}};
    const size_t lens[] = {2, 3, 4, 2, 1, 1};
    for (unsigned i = 0; i < 6; i++)
    {
        fixture f = {0};
        int c;
        agni *a = setup(&f, &c);
        uint8_t b[80], ack[44];
        size_t n = tlv(b, 1, bad[i], lens[i]);
        request(a, c, 2, 1, b, n, ack);
        rejected(ack, i == 5 ? 19 : 6);
        assert(f.calls == 0);
        finish(a, c);
        tests++;
    }
    for (int code = 10; code <= 12; code++)
    {
        fixture f = {.guard_error = code};
        int c;
        agni *a = setup(&f, &c);
        uint8_t b[30], ack[44];
        size_t n = tlv(b, 1, "A", 1);
        request(a, c, 2, 1, b, n, ack);
        rejected(ack, code);
        assert(f.calls == 0);
        finish(a, c);
        tests++;
    }
    /* A valid first action followed by invalid UTF8 must cause zero effects. */
    fixture f = {0};
    int c;
    agni *a = setup(&f, &c);
    uint8_t b[80], ack[44];
    size_t n = tlv(b, 1, "A", 1);
    n += tlv(b + n, 1, bad[0], 2);
    request(a, c, 2, 1, b, n, ack);
    rejected(ack, 6);
    assert(!f.calls);
    finish(a, c);
    tests++;
}
static void partial_failure(void)
{
    for (int fail = 1; fail <= 4; fail++)
    {
        fixture f = {.fail_call = fail};
        int c;
        agni *a = setup(&f, &c);
        uint8_t b[80], ack[44];
        size_t n = tlv(b, 1, "Aa", 2);
        request(a, c, 2, 1, b, n, ack);
        assert(ack[20] == 2 && ack[23] == 13 && ack[37] == 1);
        assert(r32(ack + 24) == (unsigned)fail - 1 && r32(ack + 28) == (unsigned)fail);
        assert(f.calls == (unsigned)fail);
        assert(!agni_pump(a));
        finish(a, c);
        tests++;
    }
}
static void sequence_and_eof(void)
{
    for (uint64_t seq = 0; seq <= 2; seq += 2)
    {
        fixture f = {0};
        int c;
        agni *a = setup(&f, &c);
        uint8_t b[20], ack[44];
        size_t n = tlv(b, 1, "A", 1);
        request(a, c, 2, seq, b, n, ack);
        rejected(ack, 4);
        assert(f.calls == 0);
        finish(a, c);
        tests++;
    }
    fixture f = {0};
    int c;
    agni *a = setup(&f, &c);
    uint8_t b[30], ack[44];
    size_t n = tlv(b, 1, "A", 1);
    request(a, c, 2, 1, b, n, ack);
    ok(ack, 2);
    request(a, c, 2, 1, b, n, ack);
    rejected(ack, 4);
    assert(f.calls == 2);
    finish(a, c);
    tests++;
    for (unsigned cut = 1; cut < 29; cut++)
    {
        fixture z = {0};
        a = setup(&z, &c);
        uint8_t p[40];
        size_t size = frame(p, 2, 1, b, n);
        assert(size == 29);
        write_all(c, p, cut);
        assert(agni_pump(a));
        shutdown(c, SHUT_WR);
        assert(!agni_pump(a));
        assert(!z.calls);
        finish(a, c);
        tests++;
    }
}
static void modifier_limits(void)
{
    fixture f = {0};
    int c;
    agni *a = setup(&f, &c);
    uint8_t b[100], ack[44];
    const uint8_t key[] = {0, 0, 0xff, 0xe3, 1};
    size_t n = tlv(b, 2, key, 5);
    n += tlv(b + n, 1, "A", 1);
    request(a, c, 2, 1, b, n, ack);
    rejected(ack, 14);
    assert(!f.calls);
    finish(a, c);
    tests++;
    fixture z = {0};
    a = setup(&z, &c);
    uint8_t large[2100];
    memset(large, 'x', sizeof(large));
    uint8_t body[2200];
    n = tlv(body, 1, large, sizeof(large));
    request(a, c, 2, 1, body, n, ack);
    rejected(ack, 7);
    assert(!z.calls);
    finish(a, c);
    tests++;
}
static void cancellation_and_guards(void)
{
    fixture f = {.guard_after = 1};
    int c;
    agni *a = setup(&f, &c);
    uint8_t b[300], ack[44];
    size_t n = tlv(b, 1, "Aa", 2);
    request(a, c, 2, 1, b, n, ack);
    assert(ack[20] == 2 && ack[23] == 11);
    assert(r32(ack + 24) == 1 && r32(ack + 28) == 1 && ack[36] == 2);
    finish(a, c);
    tests++;
    fixture z = {0};
    a = setup(&z, &c);
    uint8_t text[80];
    memset(text, 'a', 80);
    n = tlv(b, 1, text, 80);
    uint8_t p[400];
    size_t size = frame(p, 2, 1, b, n);
    write_all(c, p, size);
    assert(agni_pump(a));
    assert(agni_pump(a));
    assert(z.calls == 32);
    shutdown(c, SHUT_WR);
    assert(!agni_pump(a));
    assert(z.calls == 32);
    finish(a, c);
    tests++;
    fixture q = {0};
    a = setup(&q, &c);
    n = 0;
    const uint8_t k1[] = {0, 0, 0xff, 0xeb, 1}, k2[] = {0, 0, 0xff, 0xe3, 1};
    n += tlv(b + n, 2, k1, 5);
    n += tlv(b + n, 2, k2, 5);
    request(a, c, 2, 1, b, n, ack);
    ok(ack, 2);
    uint8_t one = 1;
    request(a, c, 4, 2, &one, 1, ack);
    ok(ack, 2);
    assert(q.events[2].code == 0x1d && q.events[3].code == 0x15b && !q.events[2].down &&
           !q.events[3].down);
    assert(ack[37] == 6);
    finish(a, c);
    tests++;
    fixture w = {0};
    a = setup(&w, &c);
    const uint8_t unsupported[] = {0, 0, 0, 0, 0x20};
    n = tlv(b, 3, unsupported, 5);
    request(a, c, 2, 1, b, n, ack);
    rejected(ack, 9);
    assert(!w.calls);
    finish(a, c);
    tests++;
    fixture close_seq = {0};
    a = setup(&close_seq, &c);
    request(a, c, 4, 2, &one, 1, ack);
    rejected(ack, 4);
    assert(ack[37] == 4 && !close_seq.calls);
    finish(a, c);
    tests++;
}
int main(void)
{
    partial_oracle();
    unicode_and_order();
    invalid_inputs();
    partial_failure();
    sequence_and_eof();
    modifier_limits();
    cancellation_and_guards();
    short_io = 1;
    partial_oracle();
    unicode_and_order();
    printf("AGNI native protocol: %u cases passed; partial header/body, UTF8, BE oracle, "
           "short/EAGAIN ACK, guards, failed native sends, order, release, noReplay, EOF\n",
           tests);
    return 0;
}
