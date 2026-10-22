import {randomBytes} from 'node:crypto';
import {createAdminBrowserSessions} from '../../application/admin-browser-sessions.mjs';

const name='__Host-ssh_admin_session';
const attributes='Path=/; HttpOnly; Secure; SameSite=Strict';
function cookie(req){
 const raw=req.headers.cookie;
 if(raw===undefined)return undefined;
 if(typeof raw!=='string'||raw.length>16384)return null;
 const values=raw.split(';').map(part=>part.trim()).filter(part=>part.startsWith(name+'='));
 if(!values.length)return undefined;
 if(values.length!==1)return null;
 const value=values[0].slice(name.length+1);
 return /^[a-f0-9]{64}$/.test(value)?value:null;
}

/** The cookie is restricted to this administrator application; no upstream logout. */
export function createBrowserSessionAdapter({now=Date.now,nonce=()=>randomBytes(32).toString('hex'),capacity}={}){
 const sessions=createAdminBrowserSessions({now,nonce,...(capacity===undefined?{}:{capacity})});
 return {
  authenticated:(req,principal)=>sessions.authenticated(cookie(req),principal),
  start(req,res,principal){
   const value=sessions.start(principal,cookie(req));
   res.setHeader('Set-Cookie',name+'='+value.id+'; '+attributes+'; Max-Age='+Math.max(1,Math.ceil((value.expiresAt-now())/1000)));
  },
  end(req,res,principal){sessions.end(cookie(req),principal);res.setHeader('Set-Cookie',name+'=; '+attributes+'; Max-Age=0');},
  close:()=>sessions.close(),
 };
}
