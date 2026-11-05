/* SPDX-License-Identifier: Apache-2.0 */
#ifndef XF_AGNI_H
#define XF_AGNI_H
#include "agni.h"
#include "xfreerdp.h"
uint32_t xf_agni_map_key(xfContext *xfc, uint32_t key);
agni *xf_agni_new(xfContext *xfc);
int xf_agni_option(int *argc, char **argv);
void xf_agni_capabilities(void);
#endif
