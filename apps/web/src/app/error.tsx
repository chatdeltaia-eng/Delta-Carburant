"use client";

import { useEffect } from "react";

const recoveryKey = "delta_frontend_recovery";

export default function ApplicationError({error,reset}:{error:Error & {digest?:string};reset:()=>void}) {
  useEffect(()=>{
    console.error("DeltaCarburant application error",error);
    const message=String(error?.message??"").toLowerCase();
    const staleBundle=["chunk","loading css","failed to fetch dynamically imported","module factory"].some(value=>message.includes(value));
    if(staleBundle&&sessionStorage.getItem(recoveryKey)!==location.pathname){
      sessionStorage.setItem(recoveryKey,location.pathname);
      const url=new URL(location.href);
      url.searchParams.set("actualisation",Date.now().toString());
      location.replace(url.toString());
    }
  },[error]);
  return <main style={{minHeight:"100vh",display:"grid",placeItems:"center",fontFamily:"Arial,sans-serif",background:"#f4f8fb",color:"#17243a"}}>
    <section style={{width:"min(430px,calc(100vw - 32px))",padding:"32px",border:"1px solid #d8e3ed",borderRadius:"20px",background:"white",boxShadow:"0 18px 50px rgba(31,52,73,.14)",textAlign:"center"}}>
      <div style={{width:48,height:48,margin:"0 auto 18px",borderRadius:16,display:"grid",placeItems:"center",background:"#fff1e7",color:"#b45309",fontSize:24}}>↻</div>
      <h1 style={{fontSize:20,margin:"0 0 10px"}}>Actualisation nécessaire</h1>
      <p style={{fontSize:13,lineHeight:1.6,color:"#607187"}}>Une nouvelle version de DeltaCarburant vient d’être déployée. Vos données sont conservées.</p>
      <div style={{display:"flex",justifyContent:"center",gap:10,marginTop:20}}>
        <button onClick={()=>location.reload()} style={{padding:"11px 18px",border:0,borderRadius:10,color:"white",background:"#075fae",fontWeight:700,cursor:"pointer"}}>Actualiser la page</button>
        <button onClick={reset} style={{padding:"11px 18px",border:"1px solid #cbd9e5",borderRadius:10,color:"#24405c",background:"white",fontWeight:700,cursor:"pointer"}}>Réessayer</button>
      </div>
    </section>
  </main>;
}
