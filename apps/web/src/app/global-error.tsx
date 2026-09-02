"use client";

import { useEffect } from "react";

export default function GlobalError({error}:{error:Error & {digest?:string}}) {
  useEffect(()=>{
    console.error("DeltaCarburant root error",error);
    const url=new URL(location.origin);
    url.searchParams.set("version",Date.now().toString());
    const timer=window.setTimeout(()=>location.replace(url.toString()),300);
    return()=>window.clearTimeout(timer);
  },[error]);
  return <html lang="fr"><body style={{margin:0}}><main style={{minHeight:"100vh",display:"grid",placeItems:"center",fontFamily:"Arial,sans-serif",background:"#f4f8fb",color:"#17243a"}}><p>Reconnexion automatique à DeltaCarburant…</p></main></body></html>;
}
