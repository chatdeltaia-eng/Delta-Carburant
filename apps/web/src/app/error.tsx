"use client";

import { useEffect } from "react";

const recoveryKey = "delta_frontend_recovery_count";

export default function ApplicationError({error,reset}:{error:Error & {digest?:string};reset:()=>void}) {
  useEffect(()=>{
    console.error("DeltaCarburant application error",error);
    void (async()=>{
      const attempts=Number(sessionStorage.getItem(recoveryKey)??0);
      sessionStorage.setItem(recoveryKey,String(attempts+1));
      if("caches" in window){
        const names=await caches.keys().catch(()=>[]);
        await Promise.all(names.map(name=>caches.delete(name))).catch(()=>undefined);
      }
      const registrations=await navigator.serviceWorker?.getRegistrations().catch(()=>[]);
      await Promise.all((registrations??[]).map(registration=>registration.unregister())).catch(()=>undefined);
      if(attempts<2){
        const url=new URL(location.href);
        url.searchParams.set("version",Date.now().toString());
        location.replace(url.toString());
        return;
      }
      sessionStorage.removeItem(recoveryKey);
      reset();
      const url=new URL(location.href);
      url.searchParams.set("version",Date.now().toString());
      location.replace(url.toString());
    })();
  },[error,reset]);
  return <main style={{minHeight:"100vh",display:"grid",placeItems:"center",fontFamily:"Arial,sans-serif",background:"#f4f8fb",color:"#17243a"}}><p>Reconnexion automatique à DeltaCarburant…</p></main>;
}
