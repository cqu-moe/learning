import type * as SdkModule from '@learning/sdk';
import type * as PromptsModule from '../src/prompts.js';
import type * as ForegroundModule from '../src/foreground.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { Command } from 'commander';
import { createLearningClient, LearningError } from '@learning/sdk';
import { createCliRuntime } from '../src/runtime.js';
import { addProfile } from '../src/profiles.js';
import { bindOutput, createOutput, resolveOutputMode } from '../src/output.js';
import { confirmCurrentAnswer } from '../src/commands/live.js';
import { registerDownloadCommands } from '../src/commands/download.js';
import { runJobForeground } from '../src/foreground.js';
const mocked = vi.hoisted(() => ({ ask: vi.fn() }));
vi.mock('../src/prompts.js', async original => ({ ...await original<typeof PromptsModule>(), createPrompts: () => ({ interactive: true, ask: mocked.ask }) }));
vi.mock('@learning/sdk', async original => { const sdk = await original<typeof SdkModule>(); return { ...sdk, createLearningClient: vi.fn(sdk.createLearningClient) }; });
vi.mock('../src/foreground.js', async original => ({ ...await original<typeof ForegroundModule>(), runJobForeground: vi.fn() }));
const sdk = await vi.importActual<typeof SdkModule>('@learning/sdk');
const directories: string[] = [];
const home = () => { const path = mkdtempSync(resolve(tmpdir(), 'learning-review-')); directories.push(path); return path; };
const sink = () => new Writable({ write(_chunk, _encoding, callback) { callback(); } });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(createLearningClient).mockImplementation(sdk.createLearningClient); vi.mocked(runJobForeground).mockReset(); mocked.ask.mockReset(); process.exitCode = 0; for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function uncertainFixture() {
  const directory=home(); const runtime=createCliRuntime(directory);
  const alpha=await addProfile(runtime.state,'alpha','ykt'); await addProfile(runtime.state,'beta','ykt');
  await runtime.state.commit({expected:[{key:'job:owned',revision:null},{key:'job-meta:owned',revision:null}],changes:[{key:'job:owned',value:{id:'owned',scope:alpha!.scope,kind:'export',status:'uncertain',createdAtMs:1,updatedAtMs:1,nextRunAtMs:null,completed:0,total:1,items:[],warnings:[]}},{key:'job-meta:owned',value:{inputDigest:'x',generation:1,cursor:null,pendingOperationId:'op-owned',running:false}}]});runtime.state.close();
  const fixture=resolve(directory,'empty.json');writeFileSync(fixture,'{"interactions":[]}');
  const run=(args:string[])=>spawnSync(process.execPath,['--import',resolve(import.meta.dirname,'fixture-fetch.mjs'),resolve(import.meta.dirname,'../dist/index.js'),'--home',directory,...args,'--json'],{encoding:'utf8',env:{...process.env,LEARNING_FIXTURE_FILE:fixture}});
  return run;
}
describe('independent review regressions', () => {
 it('preserves UNCERTAIN arriving after the question deadline once execute began', async () => {
  vi.useFakeTimers();
  const runtime = createCliRuntime(home());
  runtime.transport.fetch = async () => { throw new Error('network not registered'); };
  const scope = { userId:'local',profileId:'one',platform:'ykt' as const };
  const client = sdk.createLearningClient({scope,runtime});
  vi.spyOn(client.actions,'prepare').mockResolvedValue({id:'preview',scope,kind:'live.answer',digest:'digest',generation:1,expiresAtMs:Date.now()+10000,description:'question',startsTimer:false,finalSubmission:false,blockers:[],warnings:[]});
  vi.spyOn(client.actions,'execute').mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve,200)); throw new LearningError({code:'UNCERTAIN',message:'response lost',operationId:'op-sent',retryAfterMs:null}); });
  mocked.ask.mockResolvedValueOnce('true').mockResolvedValueOnce(true);
  const output = createOutput({format:'plain',interactive:true,quiet:false,color:false,debug:false},{stdout:sink(),stderr:sink()});
  try {
   const pending = confirmCurrentAnswer(client,'job',{type:'question',sequence:1,jobId:'job',phaseId:'phase',closesAtMs:Date.now()+100,question:{id:'1',kind:'judgement',rawType:'judge',body:{plainText:'题干',markdown:'题干',decodeState:'not-needed',sourceHash:'hash'},options:[],fingerprint:'fp',attemptsUsed:null,maxAttempts:null,myAnswer:null,feedback:null}},output);
   const checked = expect(pending).rejects.toMatchObject({data:{code:'UNCERTAIN',operationId:'op-sent'}});
   void checked.catch(() => {});
   await vi.advanceTimersByTimeAsync(250);
   await checked;
  } finally {output.close();await client.close();runtime.state.close();}
 });
 it('does not create the assessment stage after the media stage was canceled', async () => {
  const directory=home(); const runtime=createCliRuntime(directory);
  runtime.transport.fetch=async()=>{throw new Error('network not registered');};
  const profile=await addProfile(runtime.state,'alpha','ykt');
  const course={scope:profile!.scope,key:'course',native:{kind:'ykt' as const,classroomId:'1'}};
  await runtime.state.commit({expected:[{key:'cli:course:course',revision:null}],changes:[{key:'cli:course:course',value:{ref:course,title:'课程',system:null,term:null,teachers:[],locked:null}}]});
  const client=sdk.createLearningClient({scope:profile!.scope,runtime});
  vi.mocked(createLearningClient).mockReturnValue(client);
  const resources=[{ref:{course,key:'video',native:{kind:'ykt' as const,leafId:'2',leafInfoId:null}},kind:'video' as const,title:'视频',path:[],order:0,durationSeconds:null,locked:null},{ref:{course,key:'homework',native:{kind:'ykt' as const,leafId:'3',leafInfoId:null}},kind:'homework' as const,title:'作业',path:[],order:1,durationSeconds:null,locked:null}];
  vi.spyOn(client.catalog,'outline').mockResolvedValue({value:{course,completeness:'complete',roots:[{id:'root',title:'目录',children:[],resources}]},warnings:[]});
  vi.spyOn(client.assessments,'resolve').mockImplementation(async resource=>[{resource,kind:'homework',assessmentId:'4'}]);
  const create=vi.spyOn(client.jobs,'createExport');
  vi.mocked(runJobForeground).mockImplementation(async (sdkClient, activeRuntime, id)=>{activeRuntime.output?.markCanceled();await sdkClient.jobs.pause(id);return sdkClient.jobs.get(id);});
  const program=new Command().option('--home <dir>').option('--profile <name>');
  program.setOptionValue('home',directory);
  const output=createOutput(resolveOutputMode({json:true}),{stdout:sink(),stderr:sink()});
  bindOutput(program,output);registerDownloadCommands(program);
  try {await program.parseAsync(['download','course','--types','video,homework'],{from:'user'});expect(create).toHaveBeenCalledTimes(1);expect((await client.jobs.list()).items).toHaveLength(1);}
  finally {output.close();await client.close();runtime.state.close();}
 });
 it('rejects jobs show under an explicitly different profile', async () => {
  const run=await uncertainFixture();
  const wrong=run(['jobs','show','owned','--profile','beta']);expect(wrong.status).toBe(3);expect(JSON.parse(wrong.stdout).error.code).toBe('FORBIDDEN');
 });
 it('preserves uncertain job recovery details in JSON', async () => {
  const run=await uncertainFixture();
  const uncertain=run(['jobs','resume','owned']);const result=JSON.parse(uncertain.stdout);
  expect(uncertain.status).toBe(5);expect(result.data.job.id).toBe('owned');expect(result.error.operationId).toBe('op-owned');expect(result.error.hint.join(' ')).toContain('reconcile');expect(uncertain.stderr).not.toContain('learning:');
 });
 it('includes the init recovery hint in a machine error for an uninitialized job store', () => {
  const directory=resolve(home(),'uninitialized');
  const result=spawnSync(process.execPath,[resolve(import.meta.dirname,'../dist/index.js'),'--home',directory,'jobs','list','--json'],{encoding:'utf8'});
  expect(result.status).toBe(3);expect(JSON.parse(result.stdout).error.hint.join(' ')).toContain('init');expect(result.stderr).not.toContain('learning:');
 });
});
