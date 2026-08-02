import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Camera, Check, ChevronLeft, Crop, Download, FileText, Flashlight, FlashlightOff, FolderOpen, ImagePlus, LoaderCircle, MoreHorizontal, Printer, RotateCw, ScanLine, Settings, ShieldCheck, Trash2, Type, X } from 'lucide-react'
import type { Filter, LibraryItem, Page, ScanDocument } from './types'
import { storage } from './services/storage'
import { download, imageDimensions, perspectiveCrop, processImage, validCropQuad, validQuad, type Point } from './services/image'
import { buildPdf, exportFile } from './services/export'
import { recognize } from './services/ocr'
import './index.css'

const now=()=>new Date().toISOString(); const uid=()=>crypto.randomUUID();
const filterLabel=(filter:Filter)=>({original:'Original',enhance:'Enhance',monotone:'Monotone',document:'Enhance', 'black-white':'Monotone',receipt:'Receipt',whiteboard:'Whiteboard'}[filter]??'Original');
const visibleFilters:Filter[]=['original','enhance','monotone','receipt','whiteboard'];
const canonicalFilter=(filter:Filter):Filter=>filter==='document'?'enhance':filter==='black-white'?'monotone':filter;
type Detection = { confidence: number; blurScore: number; guidance: 'searching'|'ready'|'move-closer'; corners: Array<{x:number;y:number}>; frameWidth: number; frameHeight: number }
function Shell({children}:{children:React.ReactNode}){return <div className="shell"><header><Link className="brand" to="/library"><span>LS</span> LocalScan</Link><nav><Link to="/library">Library</Link><Link to="/settings"><Settings size={18}/> Settings</Link></nav></header>{children}</div>}
function useLibrary(){const [items,setItems]=useState<LibraryItem[]>([]);const [loading,setLoading]=useState(true);const refresh=async()=>{setLoading(true);try{setItems(await storage.list())}finally{setLoading(false)}};useEffect(()=>{void refresh()},[]);return{items,loading,refresh}}
function Library(){const {items,loading,refresh}=useLibrary();const nav=useNavigate();const remove=async(id:string)=>{if(confirm('Delete this local document permanently?')){await storage.remove(id);await refresh()}};return <Shell><main className="library"><section className="library-head"><div><p className="kicker">On this device only</p><h1>Your document library</h1><p>Capture, edit, export, and print without an account or upload.</p></div><Link className="primary" to="/scan"><ScanLine size={19}/> Scan document</Link></section>{loading?<p className="loading"><LoaderCircle/> Loading local documents</p>:items.length===0?<section className="empty"><ScanLine size={42}/><h2>Start with a scan or an image</h2><p>Documents remain in browser-managed local storage. Export important copies for backup.</p><Link className="primary" to="/scan">Open scanner</Link></section>:<section className="doc-grid">{items.map(({document,pages})=><article className="doc-card" key={document.id}><button className="doc-open" onClick={()=>nav(`/document/${document.id}`)}><div className="paper-stack"><span>{pages.length}</span><FileText size={38}/></div><h2>{document.title}</h2><p>{pages.length} page{pages.length===1?'':'s'} - updated {new Date(document.updatedAt).toLocaleDateString()}</p></button><button className="icon danger" onClick={()=>void remove(document.id)} aria-label={`Delete ${document.title}`}><Trash2 size={18}/></button></article>)}</section>}</main></Shell>}
function Scan(){
  const nav=useNavigate();
  const [params]=useSearchParams();
  const existingId=params.get('documentId');
  const video=useRef<HTMLVideoElement>(null);
  const input=useRef<HTMLInputElement>(null);
  const [stream,setStream]=useState<MediaStream>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [detection,setDetection]=useState<Detection>();
  const [torchSupported,setTorchSupported]=useState(false);
  const [torchOn,setTorchOn]=useState(false);
  const [guidePoints,setGuidePoints]=useState('9,12 91,12 91,88 9,88');
  const latestDetection=useRef<Detection | undefined>(undefined);

  const stopCamera=()=>{
    stream?.getTracks().forEach(track=>track.stop());
    if(video.current) video.current.srcObject=null;
    setStream(undefined);
    setDetection(undefined);
    latestDetection.current=undefined;
    setGuidePoints('9,12 91,12 91,88 9,88');
    setTorchOn(false);
    setTorchSupported(false);
  };
  useEffect(()=>()=>stream?.getTracks().forEach(track=>track.stop()),[stream]);
  const start=async()=>{
    setError('');
    try{
      if(!navigator.mediaDevices?.getUserMedia){setError('This browser does not support camera access. Import an image instead.');return}
      let next:MediaStream;
      try{next=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:24,max:30}}})}
      catch{next=await navigator.mediaDevices.getUserMedia({audio:false,video:true})}
      const track=next.getVideoTracks()[0];
      const capabilities=track?.getCapabilities?.() as MediaTrackCapabilities & {torch?:boolean}|undefined;
      setTorchSupported(Boolean(capabilities?.torch));
      setTorchOn(false);
      setStream(next);
      latestDetection.current=undefined;
    }catch{setError('Camera access was not granted. You can still import images from your device.')}
  };
  const toggleTorch=async()=>{
    const track=stream?.getVideoTracks()[0];
    if(!track||!torchSupported)return;
    const next=!torchOn;
    try{
      await track.applyConstraints({advanced:[{torch:next}]} as unknown as MediaTrackConstraints);
      setTorchOn(next);
    }catch{setError('This camera does not allow the flash to be changed while scanning.');setTorchSupported(false)}
  };
  useEffect(()=>{if(stream&&video.current){video.current.srcObject=stream;void video.current.play().catch(()=>undefined)}},[stream]);

  const save=async(blob:Blob,source:'camera'|'image-import',found?:Detection)=>{
    setBusy(true);
    try{
      const dims=await imageDimensions(blob); const created=now();
      const existing=existingId?(await storage.list()).find(item=>item.document.id===existingId):undefined;
      const id=existing?.document.id??uid(), pageId=uid();
      const rawQuad=found?.corners;
      // Detector coordinates are from the 480px analysis frame. Map them to
      // the actual captured bitmap, then reject default/noisy quads before
      // applying perspective correction.
      const normalizedQuad=rawQuad&&found?rawQuad.map(c=>({x:Math.max(0,Math.min(dims.width-1,c.x/Math.max(1,found.frameWidth)*dims.width)),y:Math.max(0,Math.min(dims.height-1,c.y/Math.max(1,found.frameHeight)*dims.height))})):undefined;
      const cropQuad=normalizedQuad&&found&&found.confidence>=.35&&validQuad(normalizedQuad,dims.width,dims.height)?normalizedQuad:undefined;
      const doc:ScanDocument=existing?{...existing.document,updatedAt:created,pageIds:[...existing.document.pageIds,pageId]}:{id,title:`Scan ${new Date().toLocaleDateString()}`,createdAt:created,updatedAt:created,pageIds:[pageId],favorite:false,tags:[],ocrStatus:'none',defaultPageSize:'a4',lastOpenedAt:created};
      const corrected=cropQuad?await perspectiveCrop(blob,cropQuad):blob;
      const outputDims=await imageDimensions(corrected);
      // The edge-corrected image is the original scan the user should review.
      // Filters are opt-in from the workspace; never make a new capture look
      // monotone before the user has chosen an enhancement.
      const page:Page={id:pageId,documentId:id,order:existing?.pages.length??0,createdAt:created,updatedAt:now(),originalPath:'original',processedPath:'processed',source,width:outputDims.width,height:outputDims.height,mimeType:corrected.type||blob.type||'image/jpeg',rotation:0,filter:'original',processingStatus:'ready',ocrStatus:'not-requested',ocrLanguageCodes:['eng'],cropQuad};
      await storage.saveDocument(doc); await storage.savePage(page,corrected,corrected); nav(`/document/${id}`);
    }catch(e){setError(e instanceof Error?e.message:'Could not save this page.')}finally{setBusy(false)}
  };
  const capture=async()=>{
    const current=video.current;
    if(!current||current.readyState<2||current.videoWidth<2||current.videoHeight<2){setError('The camera is still starting. Hold steady for a moment, then try again.');return}
    const canvas=document.createElement('canvas'); canvas.width=current.videoWidth; canvas.height=current.videoHeight;
    const context=canvas.getContext('2d'); if(!context)return;
    context.drawImage(current,0,0,canvas.width,canvas.height);
    const snapshot=latestDetection.current??detection;
    canvas.toBlob(blob=>{if(blob)void save(blob,'camera',snapshot)},'image/jpeg',.96);
  };
  useEffect(()=>{
    if(!stream||!video.current)return;
    const worker=new Worker(new URL('./workers/cv.worker.ts',import.meta.url),{type:'module'});
    const canvas=document.createElement('canvas'); const context=canvas.getContext('2d',{willReadFrequently:true});
    if(!context)return()=>worker.terminate();
    let timer=0; let pending=false; let smoothed:Detection|undefined; let analysisWidth=0; let analysisHeight=0;
    const updateGuide=(next:Detection)=>{
      const host=video.current?.parentElement; const rect=host?.getBoundingClientRect(); const videoRect=video.current?.getBoundingClientRect(); if(!rect||!videoRect)return;
      const scale=Math.min(videoRect.width/next.frameWidth,videoRect.height/next.frameHeight);
      const offsetX=(videoRect.left-rect.left)+(videoRect.width-next.frameWidth*scale)/2;
      const offsetY=(videoRect.top-rect.top)+(videoRect.height-next.frameHeight*scale)/2;
      setGuidePoints(next.corners.map(c=>`${((offsetX+c.x*scale)/rect.width)*100},${((offsetY+c.y*scale)/rect.height)*100}`).join(' '));
    };
    const analyze=()=>{
      const current=video.current;
      if(current&&current.readyState>=2&&current.videoWidth>1&&!document.hidden&&!pending){
        // Keep the analysis frame small and reuse the same backing canvas. This
        // materially reduces getImageData allocations on mid-range phones.
        const targetWidth=320;
        const nextHeight=Math.max(160,Math.round(targetWidth*current.videoHeight/current.videoWidth));
        if(analysisWidth!==targetWidth||analysisHeight!==nextHeight){canvas.width=targetWidth;canvas.height=nextHeight;analysisWidth=targetWidth;analysisHeight=nextHeight}
        context.drawImage(current,0,0,analysisWidth,analysisHeight); const frame=context.getImageData(0,0,analysisWidth,analysisHeight); pending=true;
        worker.postMessage({data:frame.data.buffer,width:analysisWidth,height:analysisHeight},[frame.data.buffer]);
      }
      timer=window.setTimeout(analyze,180);
    };
    worker.onmessage=(event:MessageEvent<Detection>)=>{
      const next=event.data; const previous=smoothed;
      if(previous&&previous.frameWidth===next.frameWidth&&previous.frameHeight===next.frameHeight){
        const alpha=next.guidance==='ready'?.34:.2;
        smoothed={...next,corners:next.corners.map((point,index)=>({x:previous.corners[index].x+(point.x-previous.corners[index].x)*alpha,y:previous.corners[index].y+(point.y-previous.corners[index].y)*alpha})) as Detection['corners']};
      }else smoothed=next;
      pending=false; latestDetection.current=smoothed; setDetection(smoothed); updateGuide(smoothed);
    };
    const visibility=()=>{
      if(document.hidden){window.clearTimeout(timer);video.current?.pause();return}
      if(video.current){void video.current.play().catch(()=>undefined)}
      analyze();
    };
    document.addEventListener('visibilitychange',visibility);
    analyze();
    return()=>{window.clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);worker.terminate()};
  },[stream]);
  return <main className="scanner"><div className="scanner-top"><Link to="/library" aria-label="Close scanner"><X/></Link><span>Live document detection</span><div className="scanner-top-actions"><button disabled={!stream||!torchSupported} onClick={()=>void toggleTorch()} aria-label={torchOn?'Turn flash off':'Turn flash on'} title={torchSupported?(torchOn?'Turn flash off':'Turn flash on'):'Flash unavailable on this camera'}>{torchOn?<FlashlightOff/>:<Flashlight/>}</button><button disabled={!stream} onClick={stopCamera}>Stop camera</button></div></div><div className="viewfinder">{stream?<video ref={video} playsInline muted/>:<div className="camera-intro"><Camera size={46}/><h1>Ready when you are</h1><p>Camera access starts only after you choose it. The outline follows the page; capture stays manual.</p><button className="primary" onClick={()=>void start()}>Enable camera</button></div>}{stream&&<div className={`crop-guide ${detection?.guidance==='ready'?'stable':''}`} aria-hidden="true"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points={guidePoints}/></svg></div>}</div><p className="scanner-status" role="status">{error||(!stream?'Enable the camera or import a document to begin.':!detection?'Analyzing the page locally':detection.guidance==='ready'?'Page found  tap capture when you are ready.':detection.guidance==='move-closer'?'Move closer so the page fills more of the frame.':'Searching for the four page edges. You can capture manually.')}</p><div className="scanner-controls"><input ref={input} hidden type="file" accept="image/*" capture="environment" onChange={e=>{const file=e.target.files?.[0];if(file)void save(file,'image-import');e.currentTarget.value=''}}/><button onClick={()=>input.current?.click()}><ImagePlus/> Import</button><button className="capture" disabled={!stream||busy} onClick={()=>void capture()} aria-label="Capture document"><span/></button><button onClick={()=>nav('/library')}><FolderOpen/> Library</button></div></main>
}

function findDoc(items:LibraryItem[],id:string){return items.find(x=>x.document.id===id)}
function CropEditor({page,onDone,onCancel}:{page:Page;onDone:()=>void;onCancel:()=>void}){
  const image=useRef<HTMLImageElement>(null); const [blob,setBlob]=useState<Blob>(); const [url,setUrl]=useState(''); const [size,setSize]=useState({width:0,height:0}); const [points,setPoints]=useState<Point[]>(); const [active,setActive]=useState<number|null>(null); const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  useEffect(()=>{let objectUrl='';let cancelled=false;void storage.blob(page,false).then(value=>{if(cancelled)return;setBlob(value);objectUrl=URL.createObjectURL(value);setUrl(objectUrl)});return()=>{cancelled=true;if(objectUrl)URL.revokeObjectURL(objectUrl)}},[page]);
  const onLoad=()=>{const element=image.current;if(!element)return;const width=element.naturalWidth;const height=element.naturalHeight;setSize({width,height});const saved=page.cropQuad?.every(point=>point.x>=0&&point.x<=width&&point.y>=0&&point.y<=height)?page.cropQuad:undefined;setPoints(saved??[{x:width*.06,y:height*.06},{x:width*.94,y:height*.06},{x:width*.94,y:height*.94},{x:width*.06,y:height*.94}])};
  const move=(event:React.PointerEvent<HTMLDivElement>)=>{if(active===null||!size.width)return;const rect=image.current?.getBoundingClientRect();if(!rect)return;const next={x:Math.max(0,Math.min(size.width,(event.clientX-rect.left)/rect.width*size.width)),y:Math.max(0,Math.min(size.height,(event.clientY-rect.top)/rect.height*size.height))};setPoints(current=>current?.map((point,index)=>index===active?next:point))};
  const apply=async()=>{if(!blob||!points||!validCropQuad(points,size.width,size.height)){setError('Place all four corners inside the image and try again.');return}setBusy(true);setError('');try{const cropped=await perspectiveCrop(blob,points);const dimensions=await imageDimensions(cropped);await storage.savePage({...page,width:dimensions.width,height:dimensions.height,filter:'original',cropQuad:points,updatedAt:now()},cropped,cropped);onDone()}catch(error){setError(error instanceof Error?error.message:'Could not apply this crop.')}finally{setBusy(false)}};
  const polygon=points?.map(point=>`${point.x/Math.max(1,size.width)*100},${point.y/Math.max(1,size.height)*100}`).join(' ')??'';
  return <div className="crop-editor"><div className="crop-editor-stage" onPointerMove={move} onPointerUp={()=>setActive(null)} onPointerCancel={()=>setActive(null)}><img ref={image} src={url} onLoad={onLoad} alt="Adjust crop corners"/><svg className="crop-overlay" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points={polygon}/></svg>{points?.map((point,index)=><button key={index} className="crop-handle" style={{left:`${point.x/Math.max(1,size.width)*100}%`,top:`${point.y/Math.max(1,size.height)*100}%`}} onPointerDown={event=>{event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);setActive(index)}} aria-label={`Move crop corner ${index+1}`} />)}</div><div className="crop-editor-actions"><button className="secondary" onClick={onCancel} disabled={busy}>Cancel</button><button className="primary" onClick={()=>void apply()} disabled={busy||!points}>{busy?<LoaderCircle className="spin"/>:<Check/>} Apply crop</button></div>{error&&<p className="crop-error" role="alert">{error}</p>}</div>}
function Workspace(){
  const {documentId}=useParams(); const {items,loading,refresh}=useLibrary(); const nav=useNavigate();
  const found=documentId?findDoc(items,documentId):undefined; const [selected,setSelected]=useState<string>(); const [cropMode,setCropMode]=useState(false);
  useEffect(()=>{if(found&&!selected)setSelected(found.pages[0]?.id)},[found,selected]);
  if(loading)return <Shell><p className="loading"><LoaderCircle/> Loading document</p></Shell>;
  if(!found)return <Navigate to="/library" replace/>;
  const page=found.pages.find(x=>x.id===selected)??found.pages[0];
  const mutate=async(changed:Page,filter?:Filter)=>{
    const original=await storage.blob(changed,false); const nextFilter=filter??changed.filter;
    const processed=await processImage(original,nextFilter,changed.rotation);
    changed.filter=nextFilter; changed.updatedAt=now();
    await storage.savePage(changed,undefined,processed); await storage.saveDocument({...found.document,updatedAt:now()}); await refresh();
  };
  const rotate=()=>page&&void mutate({...page,rotation:((page.rotation+90)%360) as 0|90|180|270});
  const crop=()=>{if(page)setCropMode(true)};
  const removePage=async()=>{if(!page||!confirm('Delete this page?'))return; const pages=found.pages.filter(x=>x.id!==page.id).map((x,i)=>({...x,order:i})); for(const item of pages)await storage.savePage(item); await storage.saveDocument({...found.document,pageIds:pages.map(x=>x.id),updatedAt:now()}); if(pages.length===0){await storage.remove(found.document.id);nav('/library')}else{setSelected(pages[0].id);await refresh()}};
  return <Shell><main className="workspace"><div className="workspace-bar"><Link className="back" to="/library"><ChevronLeft/> Library</Link><input aria-label="Document title" value={found.document.title} onChange={async e=>{await storage.saveDocument({...found.document,title:e.target.value,updatedAt:now()});await refresh()}}/><div><Link className="tool" to={`/document/${found.document.id}/text`}><Type/> Text</Link><Link className="tool" to={`/document/${found.document.id}/export`}><Download/> Export</Link><Link className="tool" to={`/document/${found.document.id}/print`}><Printer/> Print</Link></div></div><div className="editor"><aside className="pages"><Link className="add-page" to={`/scan?documentId=${found.document.id}`}><ImagePlus/> Add page</Link>{found.pages.map((item,i)=><button className={item.id===page?.id?'page-thumb selected':'page-thumb'} onClick={()=>setSelected(item.id)} key={item.id}><span>{i+1}</span><FileText/><small>{filterLabel(item.filter)}</small></button>)}</aside><section className="canvas">{page?(cropMode?<CropEditor page={page} onDone={async()=>{setCropMode(false);await refresh()}} onCancel={()=>setCropMode(false)}/>:<PageImage page={page}/>):null}</section><aside className="inspector"><h2>Page {page?found.pages.indexOf(page)+1:0}</h2><div className="filter-list">{visibleFilters.map(f=><button className={canonicalFilter(page?.filter??'original')===f?'active':''} key={f} onClick={()=>page&&void mutate({...page},f)}>{filterLabel(f)}</button>)}</div><button className="secondary" onClick={rotate}><RotateCw/> Rotate right</button><button className="secondary" onClick={crop}><Crop/> Adjust crop</button><button className="secondary danger" onClick={()=>void removePage()}><Trash2/> Delete page</button></aside></div></main></Shell>;
}
function PageImage({page}:{page:Page}){const [url,setUrl]=useState('');const isOriginal=page.filter==='original';useEffect(()=>{let u='';void storage.blob(page,!isOriginal).then(b=>{u=URL.createObjectURL(b);setUrl(u)});return()=>{if(u)URL.revokeObjectURL(u)}},[page,isOriginal]);return url?<><img className="document-image" src={url} alt="Selected scanned page" style={isOriginal?{transform:`rotate(${page.rotation}deg)`}:undefined}/><ShareButton page={page}/></>:<LoaderCircle className="spin"/>}
function ShareButton({page}:{page:Page}){
  const {items}=useLibrary(); const record=items.find(item=>item.document.id===page.documentId);
  const [busy,setBusy]=useState(false); const [message,setMessage]=useState('');
  const share=async()=>{
    if(!record)return; setBusy(true); setMessage('');
    const filename=`${record.document.title.replace(/[^a-z0-9-_]+/gi,'-')||'scan'}.pdf`;
    let pdf:Blob|undefined;
    try{
      pdf=await buildPdf(record.document,record.pages);
      const file=new File([pdf],filename,{type:'application/pdf'});
      const canShareFiles=typeof navigator.share==='function'&&(!navigator.canShare||navigator.canShare({files:[file]}));
      if(canShareFiles){
        await navigator.share({title:record.document.title,text:'Shared from LocalScan',files:[file]});
        setMessage('Shared using your device share sheet.');
      }else{
        download(pdf,filename);
        setMessage('File sharing is unavailable here, so the PDF was downloaded. Open it to choose another app.');
      }
    }catch(error){
      if(error instanceof Error&&error.name==='AbortError')return;
      if(pdf){download(pdf,filename);setMessage('The share sheet could not open, so the PDF was downloaded instead.')}
      else setMessage('Could not prepare the PDF for sharing.');
    }finally{setBusy(false)}
  };
  return <><button className="secondary share-inline" disabled={busy||!record} onClick={()=>void share()}>{busy?<LoaderCircle className="spin"/>:<Download/>} {busy?'Preparing PDF...':'Share PDF to another app'}</button>{message&&<p className="share-status" role="status">{message}</p>}</>;
}
function DocumentAction({kind}:{kind:'text'|'export'|'print'}){const {documentId}=useParams();const {items,loading,refresh}=useLibrary();const found=documentId?findDoc(items,documentId):undefined;const [running,setRunning]=useState(false);const [message,setMessage]=useState('');const [format,setFormat]=useState(kind==='export'?'pdf':'');if(loading)return <Shell><p className="loading">Loading</p></Shell>;if(!found)return <Navigate to="/library"/>;const back=`/document/${found.document.id}`;const run=async()=>{setRunning(true);try{if(kind==='text'){for(const page of found.pages){const blob=await storage.blob(page);const out=await recognize(blob,'eng',()=>undefined);await storage.savePage({...page,text:out.text,ocrStatus:out.confidence<60?'low-confidence':'complete',ocrAverageConfidence:out.confidence,ocrPath:'ocr.json'})}await storage.saveDocument({...found.document,ocrStatus:'complete',updatedAt:now()});await refresh();setMessage('OCR is complete. You can edit the recognized text below.')}else if(kind==='export'){await exportFile(found.document,found.pages,format);setMessage('Your export was prepared locally.')}else{window.print();setMessage('The browser opened its system print dialog. LocalScan cannot silently select a printer or print without your confirmation.')}}catch(e){setMessage(e instanceof Error?e.message:'The local operation could not complete.')}finally{setRunning(false)}};return <Shell><main className="action-page"><Link className="back" to={back}><ChevronLeft/> Back to document</Link><div className="action-panel"><h1>{kind==='text'?'Recognize and edit text':kind==='export'?'Export document':'Print document'}</h1>{kind==='text'?<><p>OCR runs in a local WebAssembly worker. Language assets are cached by the browser after their first load.</p><button className="primary" disabled={running} onClick={()=>void run()}>{running?<LoaderCircle className="spin"/>:<Type/>} Run English OCR</button>{found.pages.map(p=><textarea key={p.id} aria-label={`Recognized text for page ${p.order+1}`} defaultValue={p.text??''} onBlur={async e=>{await storage.savePage({...p,text:e.target.value,ocrStatus:'complete',ocrPath:'ocr.json'});await refresh()}} placeholder={`Recognized text for page ${p.order+1} will appear here.`}/>)}</>:kind==='export'?<><p>All exports use processed, full-resolution pages  never thumbnails.</p><div className="format-grid">{['pdf','searchable','text-pdf','docx','editable-docx','png','jpeg','webp','zip'].map(x=><button className={format===x?'active':''} onClick={()=>setFormat(x)} key={x}>{x.replaceAll('-',' ')}</button>)}</div><button className="primary" disabled={running||!format} onClick={()=>void run()}>{running?<LoaderCircle className="spin"/>:<Download/>} Export {format.toUpperCase()}</button></>:<><p>Preview is limited to document pages. Your browser controls printer selection and confirmation.</p><div className="print-preview">{found.pages.map(p=><PageImage key={p.id} page={p}/>)}</div><button className="primary" onClick={()=>void run()}><Printer/> Open print dialog</button></>}{message&&<p className="notice" role="status">{message}</p>}</div></main></Shell>}
function SettingsPage(){const [usage,setUsage]=useState<{usage?:number;quota?:number}>({});const [persisted,setPersisted]=useState(false);const [message,setMessage]=useState('');const [clearing,setClearing]=useState(false);const refreshUsage=async()=>{setUsage(await storage.estimate());if(navigator.storage?.persisted)setPersisted(await navigator.storage.persisted())};useEffect(()=>{void refreshUsage()},[]);const clearLocal=async()=>{if(!window.confirm('Delete every locally stored document and image? This cannot be undone.'))return;setClearing(true);setMessage('');try{await storage.clear();await refreshUsage();setMessage('Local documents cleared from this browser.')}catch(error){setMessage(error instanceof Error?error.message:'Could not clear local documents.')}finally{setClearing(false)}};const used=typeof usage.usage==='number'?`${(usage.usage/1024/1024).toFixed(1)} MB used${typeof usage.quota==='number'?` of ${(usage.quota/1024/1024/1024).toFixed(1)} GB available`:''}`:'Storage estimate unavailable.';return <Shell><main className="settings-page"><h1>Storage and privacy</h1><section><ShieldCheck/><div><h2>Stored only on this device</h2><p>LocalScan never uploads scans. Images and document data stay in this browser's private, browser-managed local storage. Clearing this site's browser data can permanently remove them.</p><p className="settings-status">Storage location: {storage.mode()}</p></div></section><section><FileText/><div><h2>Local storage</h2><p>{used}</p><button className="secondary" disabled={persisted} onClick={async()=>{setPersisted(await storage.persist());setMessage('The browser was asked to keep LocalScan data available.')}}>{persisted?'Persistent storage enabled':'Keep documents available'}</button><button className="secondary danger" disabled={clearing} onClick={()=>void clearLocal()}>{clearing?'Clearing local data…':'Clear all local documents'}</button></div></section><section><MoreHorizontal/><div><h2>Browser support</h2><p>{storage.supported()?'The browser supports OPFS for durable local documents.':'This browser is using IndexedDB for local document storage.'} Camera and printing depend on browser and hardware support.</p></div></section>{message&&<p className="notice" role="status">{message}</p>}</main></Shell>}
function Help(){return <Shell><main className="help"><h1>How LocalScan handles your documents</h1><p>There is no account, server, remote database, analytics, or document upload. Camera access begins only when you press Enable camera. If automatic scanning is unavailable, import an image or capture manually.</p><p>Printing always uses the system print dialog. Browser security does not allow silent printing or automatic printer selection.</p></main></Shell>}
export default function App(){return <Routes><Route path="/" element={<Navigate to="/library" replace/>}/><Route path="/library" element={<Library/>}/><Route path="/scan" element={<Scan/>}/><Route path="/scan/:sessionId" element={<Scan/>}/><Route path="/document/:documentId" element={<Workspace/>}/><Route path="/document/:documentId/text" element={<DocumentAction kind="text"/>}/><Route path="/document/:documentId/export" element={<DocumentAction kind="export"/>}/><Route path="/document/:documentId/print" element={<DocumentAction kind="print"/>}/><Route path="/settings" element={<SettingsPage/>}/><Route path="/storage" element={<SettingsPage/>}/><Route path="/help" element={<Help/>}/><Route path="*" element={<Navigate to="/library" replace/>}/></Routes>}
