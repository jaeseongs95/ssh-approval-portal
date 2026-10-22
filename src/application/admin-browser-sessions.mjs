/** Application-owned browser sessions; upstream owner authentication remains mandatory. */
export function createAdminBrowserSessions({nonce,now=Date.now,capacity=256}) {
 if(typeof nonce!=='function'||!Number.isSafeInteger(capacity)||capacity<1||capacity>4096)throw Error('Invalid browser session configuration');
 const sessions=new Map();let closed=false;
 const token=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
 const principal=value=>value&&typeof value.subject==='string'&&value.subject.length>0&&value.subject.length<=1024&&Number.isSafeInteger(value.expiresAt)&&value.expiresAt>now();
 const reap=()=>{for(const [id,session]of sessions)if(session.expiresAt<=now())sessions.delete(id);};
 const authenticated=(id,identity)=>{
  if(closed||!token(id)||!principal(identity))return false;
  const session=sessions.get(id);
  if(session&&session.expiresAt<=now()){sessions.delete(id);return false;}
  return Boolean(session&&session.subject===identity.subject);
 };
 return {
  authenticated,
  start(identity,existing){
   if(closed||!principal(identity))throw Error('Administrator session unavailable');
   if(authenticated(existing,identity))return {id:existing,expiresAt:sessions.get(existing).expiresAt};
   if(existing!==undefined)throw Error('Administrator session unavailable');
   reap();if(sessions.size>=capacity)throw Error('Administrator session capacity reached');
   const id=nonce();if(!token(id)||sessions.has(id))throw Error('Administrator session unavailable');
   const session={subject:identity.subject,expiresAt:identity.expiresAt};sessions.set(id,session);
   return {id,expiresAt:session.expiresAt};
  },
  end(id,identity){if(authenticated(id,identity))sessions.delete(id);},
  close(){closed=true;sessions.clear();},
 };
}
