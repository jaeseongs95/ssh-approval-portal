/** Shared structural contracts. No host SDK, filesystem, HTTP, or environment access. */
export const MAX_BYTES = 64 * 1024 * 1024;
export const CHUNK_BYTES = 256 * 1024;
export const EXPIRES_MS = 600_000;

/** @typedef {{failed:boolean, texts:string[], data?:Object}} OperationOutcome */
/** @typedef {{kind:'command'|'upload'|'download', [key:string]:unknown}} Operation */
/** @typedef {{id:string, kind:string, operation:Operation, profile:string, commandClass:string, target:string, state:string, createdAt:number, expiresAt:number, finishedAt?:number, result?:OperationOutcome, auditError?:string}} Job */
/** @typedef {{stream:AsyncIterable<Uint8Array>, expectedSize:number|null, close:()=>void|Promise<void>}} OpenedFile */
/** @typedef {{inspect:()=>{allowed:boolean,sourceHost:string}, open:(options:{signal?:AbortSignal})=>Promise<OpenedFile>}} FileSource */
/** @typedef {{fileName:string,remotePath:string,overwrite:boolean,elevate:boolean}} UploadDestination */
/** @typedef {{record:(event:Object)=>void}} AuditPort */
/** @typedef {{execute:(profile:string,command:string)=>Promise<OperationOutcome>}} CommandExecutor */
/** @typedef {{upload:(operation:Operation)=>Promise<OperationOutcome>,download:(operation:Operation)=>Promise<OperationOutcome>}} TransferExecutor */
/** @typedef {{subject:(id:string)=>string,get:(id:string)=>Readonly<Object>,verified:(id:string)=>Promise<unknown>,releaseUpload:(id:string,options:{expiresAt:number})=>void,hasActiveWork:()=>boolean,reap:()=>Promise<void>}} ArtifactLifecycle */
