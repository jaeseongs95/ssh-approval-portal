import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('packaged UI inline module remains valid JavaScript after HTML embedding',()=>{
  const html=readFileSync(new URL('../ui/dist/card.html',import.meta.url),'utf8');
  const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scripts.length,1);
  const work=mkdtempSync(join(tmpdir(),'ssh-ui-module-'));
  try{
    const file=join(work,'card.mjs');writeFileSync(file,scripts[0][1]);
    const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8',maxBuffer:2*1024*1024,windowsHide:true});
    assert.equal(result.status,0,result.stderr?.match(/SyntaxError:[^\r\n]+/)?.[0]??'Packaged UI module did not parse');
  }finally{
    assert.equal(dirname(resolve(work)),resolve(tmpdir()));
    rmSync(work,{recursive:true,force:true});
  }
});

test('web bundle is standalone JavaScript for the existing script route',()=>{
  const script=readFileSync(new URL('../web/dist/app.js',import.meta.url),'utf8');
  assert.doesNotMatch(script,/^\s*import\s/m,'web route must not require additional source-module routes');
  const work=mkdtempSync(join(tmpdir(),'ssh-web-script-'));
  try{
    const file=join(work,'app.js');writeFileSync(file,script);
    const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
  }finally{
    assert.equal(dirname(resolve(work)),resolve(tmpdir()));rmSync(work,{recursive:true,force:true});
  }
});
