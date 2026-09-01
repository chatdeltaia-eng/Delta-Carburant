"use client";

import { useEffect } from "react";

export default function GlobalError({error,reset}:{error:Error & {digest?:string};reset:()=>void}) {
  useEffect(()=>console.error("DeltaCarburant root error",error),[error]);
  return <html lang="fr"><body style={{margin:0}}><main style={{minHeight:"100vh",display:"grid",placeItems:"center",fontFamily:"Arial,sans-serif",background:"#f4f8fb",color:"#17243a"}}>
    <section style={{width:"min(430px,calc(100vw - 32px))",boxSizing:"border-box",padding:"32px",border:"1px solid #d8e3ed",borderRadius:"20px",background:"white",boxShadow:"0 18px 50px rgba(31,52,73,.14)",textAlign:"center"}}>
      <div style={{width:48,height:48,margin:"0 auto 18px",borderRadius:16,display:"grid",placeItems:"center",background:"#fff1e7",color:"#b45309",fontSize:24}}>↻</div>
      <h1 style={{fontSize:20,margin:"0 0 10px"}}>La page doit être actualisée</h1>
      <p style={{fontSize:13,lineHeight:1.6,color:"#607187"}}>Le déploiement vient de changer. Actualisez pour charger la dernière version sans perdre vos données.</p>
      <button onClick={()=>{reset();location.reload()}} style={{marginTop:20,padding:"11px 18px",border:0,borderRadius:10,color:"white",background:"#075fae",fontWeight:700,cursor:"pointer"}}>Actualiser maintenant</button>
    </section>
  </main></body></html>;
}
