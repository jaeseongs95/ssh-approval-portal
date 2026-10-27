#!/usr/bin/env python3
"""Protect and read a Compose attempt's nonsecret recovery binding."""
import json
import os
import re
import stat
import sys

BASE = '/var/lib/ssh-mcp/.maintenance-owners'
HEX = re.compile(r'^[a-f0-9]{64}$')
IMAGE = re.compile(r'^sha256:[a-f0-9]{64}$')
JOB = re.compile(r'^job\.[A-Za-z0-9]{8}$')
PROJECT = re.compile(r'^[a-z0-9][a-z0-9_-]{0,62}$')


def open_private(path, mode, *, create=False):
    flags = os.O_NOFOLLOW | (os.O_WRONLY | os.O_CREAT | os.O_EXCL if create else os.O_RDONLY)
    fd = os.open(path, flags, mode)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != mode or info.st_nlink != 1 or info.st_size > 4096:
        os.close(fd)
        raise ValueError('Unsafe recovery file')
    return fd


def validate_owner(owner):
    owner = os.path.abspath(owner)
    job = os.path.dirname(owner)
    if os.path.dirname(job) != BASE or os.path.basename(owner) != 'owner' or not JOB.fullmatch(os.path.basename(job)):
        raise ValueError('Invalid owner path')
    for path in (BASE, job):
        info = os.lstat(path)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700 or os.path.realpath(path) != path:
            raise ValueError('Unsafe recovery directory')
    fd = open_private(owner, 0o600)
    try:
        if not HEX.fullmatch(os.read(fd, 65).decode('ascii')):
            raise ValueError('Invalid owner')
    finally:
        os.close(fd)
    return job


def valid(record):
    return (set(record) == {'candidate', 'before_env', 'env_file', 'project', 'manifest'}
            and isinstance(record['candidate'], str) and IMAGE.fullmatch(record['candidate'])
            and isinstance(record['before_env'], str) and HEX.fullmatch(record['before_env'])
            and isinstance(record['manifest'], str) and HEX.fullmatch(record['manifest'])
            and isinstance(record['project'], str) and PROJECT.fullmatch(record['project'])
            and isinstance(record['env_file'], str) and os.path.isabs(record['env_file'])
            and os.path.abspath(record['env_file']) == record['env_file']
            and not any(c in record['env_file'] for c in '\r\n\0'))


def main(args):
    if len(args) < 2 or args[0] not in ('save', 'read'):
        raise ValueError('Invalid action')
    action, owner, *values = args
    job = validate_owner(owner)
    path = os.path.join(job, 'compose-intent.json')
    if action == 'save':
        if len(values) != 5:
            raise ValueError('Invalid binding')
        record = dict(zip(('candidate', 'before_env', 'env_file', 'project', 'manifest'), values))
        if not valid(record):
            raise ValueError('Invalid binding')
        fd = open_private(path, 0o600, create=True)
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(record, stream, ensure_ascii=True, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        fd = os.open(job, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    else:
        if values:
            raise ValueError('Invalid binding')
        fd = open_private(path, 0o600)
        with os.fdopen(fd, encoding='utf-8') as stream:
            record = json.load(stream)
        if not valid(record):
            raise ValueError('Invalid binding')
        for key in ('candidate', 'before_env', 'env_file', 'project', 'manifest'):
            print(record[key])


if __name__ == '__main__':
    main(sys.argv[1:])
