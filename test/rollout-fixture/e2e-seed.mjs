// Synthetic, non-empty durable state for isolated Linux CI.
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const [source, root] = process.argv.slice(2);
const {createCommandState} = await import(pathToFileURL(resolve(source,'src/adapters/storage/command-state.mjs')));
const {createAgentCliState} = await import(pathToFileURL(resolve(source,'src/adapters/storage/agent-cli-state.mjs')));
const {AGENT_CLI_CONTRACT} = await import(pathToFileURL(resolve(source,'src/domain/agent-cli.mjs')));
const {CommandOutputs} = await import(pathToFileURL(resolve(source,'src/adapters/storage/command-output.mjs')));
const id = '1'.repeat(48), commands = createCommandState(root);
commands.insert({id,kind:'command',state:'completed',operation:{kind:'command',command:'true'}},'fixture-request','2'.repeat(64));
commands.close();
const cli = createAgentCliState(root);
cli.insert({id:'3'.repeat(48),kind:'command',state:'completed',operation:{agentCliContract:AGENT_CLI_CONTRACT,agentCliTargetId:'fixture-dormant'}},'agent-cli:'+'x'.repeat(16),'4'.repeat(64));
cli.close();
const outputs = new CommandOutputs(root);
outputs.finish(outputs.reserve({executionId:id}),{failed:false,texts:['fixture output']}); outputs.close();
