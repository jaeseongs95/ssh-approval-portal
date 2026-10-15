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
/** @typedef {()=>number} Clock */
/** @typedef {(event:Readonly<Object>)=>void} AuditPort Synchronous; admission fails if it throws. */
/** @typedef {(profile:string,command:string)=>Promise<OperationOutcome>} CommandExecutor */
/** @typedef {{upload:(operation:Operation)=>Promise<OperationOutcome>,download:(operation:Operation)=>Promise<OperationOutcome>}} TransferExecutor */
/** @typedef {{id:string,fileName:string,remotePath:string,size:number,sha256?:string,expiresAt:number,state:string,overwrite?:boolean,elevate?:boolean}} Artifact */
/** @typedef {{createReadStream:(options:{start:number,autoClose:boolean})=>AsyncIterable<Uint8Array>,close:()=>Promise<void>}} VerifiedArtifact */
/**
 * @typedef {Object} ArtifactLifecycle
 * @property {number} maxBytes Per-file ceiling; readonly.
 * @property {number} budget Total reservation ceiling; readonly.
 * @property {number} reserved Current reservation; readonly.
 * @property {number} size Number of retained artifacts; readonly.
 * @property {(id:string)=>string} subject
 * @property {(id:string)=>Readonly<Artifact>} get
 * @property {()=>ReadonlyArray<Readonly<Artifact>>} list
 * @property {(id:string)=>boolean} has
 * @property {(meta:Object)=>Promise<Readonly<Artifact>>} begin
 * @property {(id:string,sequence:number,bytes:Uint8Array)=>Promise<{sequence:number,received:number}>} append
 * @property {(id:string)=>Promise<Readonly<Artifact>>} finish
 * @property {(meta:UploadDestination,openSource:()=>Promise<OpenedFile>,options:{signal?:AbortSignal})=>Promise<Readonly<Artifact>>} importFile
 * @property {(meta:Object)=>Readonly<Artifact>} reserveDownload
 * @property {(id:string,metadata:{size:number,sha256:string},writeTo:(destination:unknown)=>Promise<void>)=>Promise<Readonly<Artifact>>} receiveDownload
 * @property {(id:string)=>Promise<VerifiedArtifact>} verified
 * @property {(id:string,options:{expiresAt:number})=>void} releaseUpload
 * @property {(id:string)=>Promise<void>} remove
 * @property {()=>boolean} hasActiveWork
 * @property {()=>Promise<void>} reap
 */
/** @typedef {{call:(command:string,payload:Object)=>Promise<Object>,upload:(source:unknown,path:string,options:{maxBytes:number})=>Promise<unknown>,download:(path:string,destination:unknown,options:{maxBytes:number})=>Promise<unknown>}} SshSession */
/** @typedef {{connect:(profile:string)=>Promise<SshSession>}} SshTransport */
