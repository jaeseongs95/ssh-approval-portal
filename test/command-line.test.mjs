import test from 'node:test';
import assert from 'node:assert/strict';
import {commandLineNames} from '../src/domain/command-line.mjs';

test('all shell segments and literal substitutions contribute names, never argument risk', () => {
  for (const [line, expected] of [
    ['env CMD=rm sh -c "$CMD"',['env']], ['python3 -c "code"',['python3']], ['find /tmp -exec rm {} +',['find']], ['bash script.sh',['bash']], ['ls -la /tmp',['ls']], ['rm -rf /tmp/fixture',['rm']], ['ls && pwd',['ls','pwd']],
    ['ls; pwd | grep home || id',['ls','pwd','grep','id']], ['ls & pwd',['ls','pwd']],
    ['ls "a; rm x"',['ls']], ["grep '$(rm x)' /tmp/data",['grep']],
    ['ls $(pwd)',['pwd','ls']], ['ls "$(id)"',['id','ls']], ['ls `pwd`',['pwd','ls']],
    ['bash -lc "ls && pwd"',['bash','ls','pwd']], ['sh -ec "ls && pwd"',['sh','ls','pwd']], ['bash --noprofile -l -c "ls && pwd" extra',['bash','ls','pwd']], ['sh -c "ls && pwd"',['sh','ls','pwd']], ['ls > /tmp/file',['ls']], ['2>/tmp/file rm x',['rm']],
    ['ls 2> /tmp/file',['ls']], ['ls >$(pwd)',['pwd','ls']], ["l's' /tmp",['ls']],
  ]) { const result=commandLineNames(line); assert.equal(result.complete,true,line);assert.deepEqual(result.names,expected,line); }
});

test('uncertain syntax cannot establish all-name approval', () => {
  for(const line of ['ls &&','ls |','ls ||','ls; ; rm x','ls "unterminated','ls $(id','${CMD} x','$(pwd) x','ls\nrm x', 'if true; then rm x; fi','(ls; rm x)','ls <(id)', 'cat <<EOF','ls $((1+1))',"'A=x' ls",'A=x ls','ls\u00a0custom']) assert.equal(commandLineNames(line).complete,false,line);
  let nested='ls';for(let i=0;i<25;i++)nested='ls $('+nested+')';
  assert.equal(commandLineNames(nested).complete,false);
});

test('sudo is separate authority and its inner executable still contributes a name', () => {
  for(const [line,names] of [['bash +e -c "sudo id"',['bash','sudo','id']], ['bash -lc "sudo id"',['bash','sudo','id']], ['sudo -n ls',['sudo','ls']],['sudo -u root rm -rf /tmp/x',['sudo','rm']],['sudo --user=root id',['sudo','id']],['sudo -l',['sudo']],['ls $(sudo -n id)',['sudo','id','ls']]]) {
    const result=commandLineNames(line);assert.equal(result.complete,true,line);assert.equal(result.usesSudo,true);assert.deepEqual(result.names,names);
  }
  const unknown=commandLineNames('/usr/bin/sudo -n ls');assert.equal(unknown.usesSudo,true);assert.equal(unknown.complete,false);
  assert.equal(commandLineNames("printf 'sudo rm' ").usesSudo,false);
});
