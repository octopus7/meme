export const SEARCH_JS = `(()=>{const f=document.querySelector("form"),i=f.querySelector("input[name=q]"),r=document.getElementById("results");let t,c,ime=false;const go=()=>{clearTimeout(t);if(ime)return;const q=i.value.trim();if(!q){c?.abort();r.replaceChildren();return}t=setTimeout(async()=>{c?.abort();c=new AbortController();try{const x=await fetch("/api/search?q="+encodeURIComponent(q),{signal:c.signal,headers:{accept:"text/html"}});if(x.ok)r.innerHTML=await x.text()}catch(e){if(e.name!=="AbortError")r.textContent="검색 실패"}},150)};f.addEventListener("submit",e=>{e.preventDefault();go()});i.addEventListener("input",go);i.addEventListener("compositionstart",()=>ime=true);i.addEventListener("compositionend",()=>{ime=false;go()})})();`;

export const UPLOAD_JS = `(()=>{const f=document.getElementById("upload-form"),c=document.getElementById("upload-console");if(!f||!c)return;const b=f.querySelector("button"),stamp=()=>new Date().toLocaleTimeString(undefined,{hour12:false}),log=(level,message)=>{const line="["+stamp()+"] "+level.padEnd(7)+" "+message;c.append(document.createTextNode(line+"\\n"));c.scrollTop=c.scrollHeight};log("READY","업로드 폼 준비 완료");f.elements.image.addEventListener("change",()=>{const file=f.elements.image.files[0];log("SELECT",file?"파일 선택: "+file.name+" ("+file.type+", "+file.size+" bytes)":"파일 선택 취소")});f.addEventListener("invalid",e=>{log("INVALID",e.target.name+" 필드를 확인하세요")},true);f.addEventListener("submit",async e=>{e.preventDefault();const file=f.elements.image.files[0],description=f.elements.description.value.trim();if(!file){log("ERROR","선택된 이미지가 없습니다");return}const started=performance.now(),requestId=crypto.randomUUID();b.disabled=true;log("START","요청 "+requestId);log("INFO","파일="+file.name+", MIME="+(file.type||"application/octet-stream")+", 크기="+file.size+" bytes");log("INFO","설명 길이="+description.length+"자");try{log("FETCH","POST /api/images 전송 시작");const r=await fetch("/api/images",{method:"POST",headers:{"content-type":file.type||"application/octet-stream","x-original-filename":encodeURIComponent(file.name),"x-description":encodeURIComponent(description),"x-client-request-id":requestId},body:file});log("HTTP",r.status+" "+r.statusText);const raw=await r.text();log("BODY",(raw||"(empty response)").slice(0,2000));let value={};try{value=raw?JSON.parse(raw):{}}catch{throw new Error("응답이 JSON 형식이 아닙니다")}if(!r.ok)throw new Error(typeof value.error==="string"?value.error:"업로드 실패");log("SUCCESS","업로드 완료: id="+String(value.id||"")+", hash="+String(value.hash||""));f.reset()}catch(error){log("ERROR",error instanceof Error?error.message:String(error))}finally{b.disabled=false;log("DONE","총 "+Math.round(performance.now()-started)+"ms")}})})();`;

export const ALL_JS = `(()=>{document.addEventListener("click",async e=>{const b=e.target.closest("button[data-delete]");if(!b||!confirm("삭제할까요?"))return;b.disabled=true;try{const r=await fetch("/api/images/"+encodeURIComponent(b.dataset.delete),{method:"DELETE"});if(!r.ok&&r.status!==202)throw new Error("삭제 실패");b.closest("article")?.remove()}catch(e){b.disabled=false;alert(e.message)}})})();`;

export const DEPLOYMENT_JS = `(()=>{const e=document.getElementById("deployment-info");if(!e)return;fetch("/assets/deployment-info.json",{cache:"no-store",headers:{accept:"application/json"}}).then(r=>{if(!r.ok)throw new Error("deployment metadata unavailable");return r.json()}).then(v=>{if(typeof v.deployedAt!=="string"||typeof v.commitSha!=="string")throw new Error("invalid deployment metadata");const d=new Date(v.deployedAt);if(Number.isNaN(d.getTime()))throw new Error("invalid deployment time");const z=Intl.DateTimeFormat().resolvedOptions().timeZone||"local";const t=new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"medium"}).format(d);const s=v.commitSha.slice(0,7);e.textContent="배포: "+t+" ("+z+") · commit "+s;e.title="배포 시각(UTC): "+v.deployedAt+"\\ncommit: "+v.commitSha}).catch(()=>{e.textContent="배포 정보를 확인할 수 없습니다"})})();`;

export const APP_CSS = `
:root{color-scheme:light;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fb}
body{margin:0}
a{color:#3157c8}
.all-shell{min-height:100vh}
.all-toolbar{position:sticky;z-index:10;top:0;display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.8rem clamp(1rem,4vw,2.5rem);border-bottom:1px solid #e4e8f0;background:rgba(255,255,255,.92);box-shadow:0 4px 18px rgba(31,45,78,.06);backdrop-filter:blur(12px)}
.brand{color:#172033;font-size:1.15rem;font-weight:800;letter-spacing:-.03em;text-decoration:none}
.toolbar-actions{display:flex;align-items:center;gap:.6rem}
.toolbar-link,.logout-button{display:inline-flex;align-items:center;justify-content:center;min-height:2.25rem;padding:0 .85rem;border-radius:999px;text-decoration:none}
.toolbar-link{background:#eef2ff;color:#2f50ba}
.logout-button{border:1px solid #f0c9cd;background:#fff5f5;color:#b4232f;font-weight:700}
.all-page{box-sizing:border-box;width:min(1180px,100%);margin:0 auto;padding:clamp(1rem,4vw,2.5rem)}
.upload-panel{margin-bottom:1.5rem;border:1px solid #dfe5ef;border-radius:14px;background:#fff;box-shadow:0 8px 28px rgba(33,48,82,.07);overflow:hidden}
.upload-panel>summary{padding:1rem 1.15rem;cursor:pointer;font-weight:750;list-style-position:inside}
.upload-panel[open]>summary{border-bottom:1px solid #edf0f5}
.upload-panel form,.upload-panel .upload-console{width:auto;margin:1rem 1.15rem}
.upload-panel form{display:flex;align-items:end;flex-wrap:wrap;gap:.8rem}
.upload-panel form p{margin:0}
.upload-panel label{display:grid;gap:.35rem;color:#4b5568;font-size:.85rem;font-weight:650}
.upload-panel input{box-sizing:border-box;min-height:2.4rem;padding:.45rem .6rem;border:1px solid #cfd6e3;border-radius:8px;background:#fff;color:#172033}
.upload-panel button,.delete-button{min-height:2.35rem;padding:.45rem .8rem;border:0;border-radius:8px;cursor:pointer;font-weight:750}
.upload-panel button{background:#3157c8;color:#fff}
.upload-panel button:disabled{cursor:wait;opacity:.55}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:1rem}
.meme-card{min-width:0;overflow:hidden;border:1px solid #e1e6ef;border-radius:14px;background:#fff;box-shadow:0 8px 24px rgba(33,48,82,.08);transition:transform .15s ease,box-shadow .15s ease}
.meme-card:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(33,48,82,.13)}
.meme-image{display:block;aspect-ratio:1;overflow:hidden;background:#eef1f6}
.meme-image img{display:block;width:100%;height:100%;object-fit:cover}
.meme-card-body{display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.8rem .9rem}
.meme-description{min-width:0;margin:0;overflow-wrap:anywhere}
.delete-button{flex:none;background:#fff0f1;color:#b4232f}
.empty-state{grid-column:1/-1;margin:2rem 0;padding:2rem;border:1px dashed #cbd3e1;border-radius:14px;color:#667085;text-align:center}
.next-page{text-align:center}
.next-page a{display:inline-block;padding:.65rem 1rem;border-radius:999px;background:#3157c8;color:#fff;text-decoration:none}
.login-shell{display:grid;min-height:100vh;place-items:center;padding:1rem}
.login-card{box-sizing:border-box;width:min(420px,100%);padding:clamp(1.5rem,6vw,2.5rem);border:1px solid #e1e6ef;border-radius:20px;background:#fff;box-shadow:0 20px 60px rgba(33,48,82,.14);text-align:center}
.login-card h1{margin:.2rem 0 .75rem;font-size:2.4rem;letter-spacing:-.06em}
.login-card>p:not(.login-eyebrow){margin:0 0 1.5rem;color:#667085;line-height:1.6}
.login-eyebrow{margin:0;color:#3157c8;font-size:.75rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
.google-login-button{display:inline-flex;align-items:center;justify-content:center;min-height:2.75rem;padding:0 1.2rem;border-radius:10px;background:#3157c8;color:#fff;font-weight:750;text-decoration:none;box-shadow:0 8px 18px rgba(49,87,200,.24)}
.google-login-button:hover{background:#2748aa}
.upload-console{box-sizing:border-box;width:100%;min-height:8rem;max-height:20rem;overflow:auto;margin:.75rem 0;padding:.75rem;border:1px solid #30363d;border-radius:8px;background:#0d1117;color:#c9d1d9;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.upload-console:empty::before{content:"업로드 로그 대기 중";color:#8b949e}
footer{box-sizing:border-box;width:min(1180px,100%);margin:1rem auto 0;padding:0 clamp(1rem,4vw,2.5rem) 1.5rem;color:#667085}
@media(max-width:560px){.toolbar-link,.logout-button{padding:0 .65rem}.all-page{padding:1rem}.gallery{grid-template-columns:repeat(2,minmax(0,1fr));gap:.7rem}.meme-card-body{align-items:flex-start;flex-direction:column}.delete-button{width:100%}}
`;
