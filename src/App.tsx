/// <reference types="vite-plugin-pwa/client" />
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Camera, Check, ChevronLeft, Crop, Download, FileText, Flashlight, FlashlightOff, FolderOpen, ImagePlus, LoaderCircle, MoreHorizontal, Printer, RotateCw, ScanLine, Settings, ShieldCheck, Trash2, Type, X } from 'lucide-react'
import type { Filter, LibraryItem, Page, ScanDocument } from './types'
import { storage } from './services/storage'
import { download, imageDimensions, perspectiveCrop, processImage, validCropQuad, validQuad, type Point } from './services/image'
import { registerSW } from 'virtual:pwa-register'
import './index.css'

const now=()=>new Date().toISOString(); const uid=()=>crypto.randomUUID();
const filterLabel=(filter:Filter)=>({original:'Original',enhance:'Enhance',monotone:'Monotone',document:'Enhance', 'black-white':'Monotone',receipt:'Receipt',whiteboard:'Whiteboard'}[filter]??'Original');
const visibleFilters:Filter[]=['original','enhance','monotone','receipt','whiteboard'];
const canonicalFilter=(filter:Filter):Filter=>filter==='document'?'enhance':filter==='black-white'?'monotone':filter;
const EMPTY_PAGES: Page[]=[];
type Detection = { confidence: number; blurScore: number; guidance: 'searching'|'ready'|'move-closer'; corners: Array<{x:number;y:number}>; frameWidth: number; frameHeight: number }
function UpdatePrompt(){
  const [refresh,setRefresh]=useState<(()=>void)|undefined>();
  useEffect(()=>{
    const update=registerSW({onNeedRefresh:()=>setRefresh(()=>()=>void update(true))});
  },[]);
  if(!refresh)return null;
  return <aside className="update-prompt" role="status"><span>A newer LocalScan is ready.</span><button className="secondary" onClick={refresh}>Update now</button><button className="icon" aria-label="Dismiss update notice" onClick={()=>setRefresh(undefined)}><X size={18}/></button></aside>
}
function Shell({children}:{children:React.ReactNode}){return <div className="shell"><header><Link className="brand" to="/library"><span>LS</span> LocalScan</Link><nav><NavLink to="/library">Library</NavLink><NavLink to="/settings"><Settings size={18}/> Settings</NavLink><NavLink to="/help">Help</NavLink></nav></header>{children}</div>}
function useLibrary(){
  const [items,setItems]=useState<LibraryItem[]>([]); const [loading,setLoading]=useState(true); const [error,setError]=useState('');
  const refresh=async()=>{setLoading(true);setError('');try{setItems(await storage.list())}catch(cause){setError(cause instanceof Error?cause.message:'Local documents could not be loaded.')}finally{setLoading(false)}};
  useEffect(()=>{void refresh()},[]);
  return{items,loading,error,refresh}
}
function DocumentPreview({pages}:{pages:Page[]}){
  const [url,setUrl]=useState('');
  useEffect(()=>{let objectUrl='';let cancelled=false;const first=pages[0];if(!first){setUrl('');return}void storage.blob(first).then(blob=>{objectUrl=URL.createObjectURL(blob);if(cancelled){URL.revokeObjectURL(objectUrl);return}setUrl(objectUrl)}).catch(()=>setUrl(''));return()=>{cancelled=true;if(objectUrl)URL.revokeObjectURL(objectUrl)}},[pages]);
  return <div className="paper-stack">{url?<img src={url} alt=""/>:<FileText size={38}/>}<span>{pages.length}</span></div>
}
function Library(){
  const {items,loading,error,refresh}=useLibrary();const nav=useNavigate();const [actionError,setActionError]=useState('');
  const remove=async(id:string)=>{if(!confirm('Delete this local document permanently?'))return;setActionError('');try{await storage.remove(id);await refresh()}catch(cause){setActionError(cause instanceof Error?cause.message:'Could not delete this local document.')}};
  return <Shell><main className="library"><section className="library-head"><div><p className="kicker">On this device only</p><h1>Your document library</h1><p>Capture, edit, export, and print without an account or upload.</p></div><Link className="primary" to="/scan"><ScanLine size={19}/> Scan document</Link></section>{loading?<p className="loading"><LoaderCircle/> Loading local documents</p>:error?<section className="empty"><FileText size={42}/><h2>Could not load local documents</h2><p>{error}</p><button className="primary" onClick={()=>void refresh()}>Try again</button></section>:items.length===0?<section className="empty"><ScanLine size={42}/><h2>Start with a scan or an image</h2><p>Documents remain in browser-managed local storage. Export important copies for backup.</p><Link className="primary" to="/scan">Open scanner</Link></section>:<section className="doc-grid">{items.map(({document,pages})=><article className="doc-card" key={document.id}><button className="doc-open" onClick={()=>nav(`/document/${document.id}`)}><DocumentPreview pages={pages}/><h2>{document.title}</h2><p>{pages.length} page{pages.length===1?'':'s'} - updated {new Date(document.updatedAt).toLocaleDateString()}</p></button><button className="icon danger" onClick={()=>void remove(document.id)} aria-label={`Delete ${document.title}`}><Trash2 size={18}/></button></article>)}</section>}{actionError&&<p className="notice" role="alert">{actionError}</p>}</main></Shell>
}
function Scan(){
  const nav=useNavigate();
  const location=useLocation();
  const [params]=useSearchParams();
  const existingId=params.get('documentId');
  const video=useRef<HTMLVideoElement>(null);
  const input=useRef<HTMLInputElement>(null);
  const [stream,setStream]=useState<MediaStream>();
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [cameraStarting,setCameraStarting]=useState(false);
  const [detection,setDetection]=useState<Detection>();
  const [detectorFailed,setDetectorFailed]=useState(false);
  const [detectorRevision,setDetectorRevision]=useState(0);
  const [torchSupported,setTorchSupported]=useState(false);
  const [torchOn,setTorchOn]=useState(false);
  const [guidePoints,setGuidePoints]=useState('9,12 91,12 91,88 9,88');
  const latestDetection=useRef<Detection | undefined>(undefined);
  const stopCameraRef=useRef<()=>void>(()=>undefined);
  const sessionRef=useRef(0);

  const stopCamera=()=>{
    // Invalidate pending camera/capture work before releasing the stream.
    sessionRef.current+=1;
    stream?.getTracks().forEach(track=>track.stop());
    if(video.current) video.current.srcObject=null;
    setStream(undefined);
    setDetection(undefined);
    latestDetection.current=undefined;
    setGuidePoints('9,12 91,12 91,88 9,88');
    setTorchOn(false);
    setTorchSupported(false);
    setCameraStarting(false);
  };
  stopCameraRef.current=stopCamera;
  // A scanner route is always a new capture session. Reset transient state when
  // the route is entered again, but leave saved documents in the local library.
  useEffect(()=>{
    // Invalidate an in-flight permission request before stopping the old
    // stream. A prompt can resolve after navigation; never attach that stale
    // stream to the newly opened scanner.
    sessionRef.current+=1;
    stopCameraRef.current();
    setError('');
    setBusy(false);
    setCameraStarting(false);
    setDetectorFailed(false);
    setDetection(undefined);
    latestDetection.current=undefined;
    if(input.current)input.current.value='';
    return()=>{
      // Leaving the route also invalidates pending permission requests and
      // releases any stream that is still attached to this session.
      sessionRef.current+=1;
      stopCameraRef.current();
    };
  },[location.key]);
  useEffect(()=>()=>stream?.getTracks().forEach(track=>track.stop()),[stream]);
  const start=async()=>{
    if(cameraStarting||stream)return;
    const session=sessionRef.current;
    setError('');
    setCameraStarting(true);
    try{
      if(!navigator.mediaDevices?.getUserMedia){setError('This browser does not support camera access. Import an image instead.');return}
      let next:MediaStream;
      try{next=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:24,max:30}}})}
      catch{if(session!==sessionRef.current)return; next=await navigator.mediaDevices.getUserMedia({audio:false,video:true})}
      if(session!==sessionRef.current){next.getTracks().forEach(track=>track.stop());return}
      const track=next.getVideoTracks()[0];
      const capabilities=track?.getCapabilities?.() as MediaTrackCapabilities & {torch?:boolean}|undefined;
      setTorchSupported(Boolean(capabilities?.torch));
      setTorchOn(false);
      setStream(next);
      latestDetection.current=undefined;
    }catch{if(session===sessionRef.current)setError('Camera access was not granted. You can still import images from your device.')}finally{if(session===sessionRef.current)setCameraStarting(false)}
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

  const save=async(blob:Blob,source:'camera'|'image-import',found?:Detection,expectedSession=sessionRef.current)=>{
    const isCurrent=()=>expectedSession===sessionRef.current;
    if(!isCurrent())return;
    setBusy(true);
    try{
      const dims=await imageDimensions(blob); if(!isCurrent())return; const created=now();
      const existing=existingId?(await storage.list()).find(item=>item.document.id===existingId):undefined;
      if(!isCurrent())return;
      const id=existing?.document.id??uid(), pageId=uid();
      const rawQuad=found?.corners;
      // Detector coordinates are from the 480px analysis frame. Map them to
      // the actual captured bitmap, then reject default/noisy quads before
      // applying perspective correction.
      const normalizedQuad=rawQuad&&found?rawQuad.map(c=>({x:Math.max(0,Math.min(dims.width-1,c.x/Math.max(1,found.frameWidth)*dims.width)),y:Math.max(0,Math.min(dims.height-1,c.y/Math.max(1,found.frameHeight)*dims.height))})):undefined;
      const cropQuad=normalizedQuad&&found&&found.confidence>=.35&&validQuad(normalizedQuad,dims.width,dims.height)?normalizedQuad:undefined;
      const doc:ScanDocument=existing?{...existing.document,updatedAt:created,pageIds:[...existing.document.pageIds,pageId]}:{id,title:`Scan ${new Date().toLocaleDateString()}`,createdAt:created,updatedAt:created,pageIds:[pageId],favorite:false,tags:[],ocrStatus:'none',defaultPageSize:'a4',lastOpenedAt:created};
      const corrected=cropQuad?await perspectiveCrop(blob,cropQuad):blob;
      if(!isCurrent())return;
      const outputDims=await imageDimensions(corrected);
      // The edge-corrected image is the original scan the user should review.
      // Filters are opt-in from the workspace; never make a new capture look
      // monotone before the user has chosen an enhancement.
      const page:Page={id:pageId,documentId:id,order:existing?.pages.length??0,createdAt:created,updatedAt:now(),originalPath:'original',processedPath:'processed',source,width:outputDims.width,height:outputDims.height,mimeType:corrected.type||blob.type||'image/jpeg',rotation:0,filter:'original',processingStatus:'ready',ocrStatus:'not-requested',ocrLanguageCodes:['eng'],cropQuad};
      await storage.saveDocument(doc); if(!isCurrent())return; await storage.savePage(page,corrected,corrected); if(isCurrent())nav(`/document/${id}`);
    }catch(e){if(isCurrent())setError(e instanceof Error?e.message:'Could not save this page.')}finally{if(isCurrent())setBusy(false)}
  };
  const capture=async()=>{
    const current=video.current;
    if(!current||current.readyState<2||current.videoWidth<2||current.videoHeight<2){setError('The camera is still starting. Hold steady for a moment, then try again.');return}
    const canvas=document.createElement('canvas'); canvas.width=current.videoWidth; canvas.height=current.videoHeight;
    const context=canvas.getContext('2d'); if(!context)return;
    context.drawImage(current,0,0,canvas.width,canvas.height);
    const snapshot=latestDetection.current??detection;
    const captureSession=sessionRef.current;
    canvas.toBlob(blob=>{if(blob)void save(blob,'camera',snapshot,captureSession)},'image/jpeg',.96);
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
    const workerFailed=()=>{
      pending=false;
      window.clearTimeout(timer);
      latestDetection.current=undefined;
      setDetection(undefined);
      setDetectorFailed(true);
      setError('Live page detection paused. You can still capture manually, or restart detection.');
      worker.terminate();
    };
    worker.onerror=event=>{event.preventDefault();workerFailed()};
    worker.onmessageerror=workerFailed;
    const visibility=()=>{
      if(document.hidden){window.clearTimeout(timer);video.current?.pause();return}
      if(video.current){void video.current.play().catch(()=>undefined)}
      analyze();
    };
    document.addEventListener('visibilitychange',visibility);
    analyze();
    return()=>{window.clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);worker.terminate()};
  },[stream,detectorRevision]);
  const restartDetection=()=>{setError('');setDetectorFailed(false);setDetectorRevision(value=>value+1)};
  return <main className="scanner"><div className="scanner-top"><Link to="/library" aria-label="Close scanner"><X/></Link><span>Live document detection</span><div className="scanner-top-actions"><button disabled={!stream||!torchSupported} onClick={()=>void toggleTorch()} aria-label={torchOn?'Turn flash off':'Turn flash on'} title={torchSupported?(torchOn?'Turn flash off':'Turn flash on'):'Flash unavailable on this camera'}>{torchOn?<FlashlightOff/>:<Flashlight/>}</button><button disabled={!stream} onClick={stopCamera}>Stop camera</button></div></div><div className="viewfinder">{stream?<video ref={video} playsInline muted aria-label="Live camera view"/>:<div className="camera-intro"><Camera size={46}/><h1>Ready when you are</h1><p>Camera access starts only after you choose it. The outline follows the page; capture stays manual.</p><button className="primary" disabled={cameraStarting} onClick={()=>void start()}>{cameraStarting?<><LoaderCircle className="spin"/> Starting camera...</>:<>Enable camera</>}</button></div>}{stream&&<div className={`crop-guide ${detection?.guidance==='ready'?'stable':''}`} aria-hidden="true"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points={guidePoints}/></svg></div>}</div><p className="scanner-status" role={error?'alert':'status'}>{error||(!stream?(cameraStarting?'Requesting camera access...':'Enable the camera or import a document to begin.'):!detection?'Analyzing the page locally':detection.guidance==='ready'?'Page found — tap Capture when you are ready.':detection.guidance==='move-closer'?'Move closer so the page fills more of the frame.':'Searching for the four page edges. You can capture manually.')}</p>{detectorFailed&&stream&&<button className="secondary" onClick={restartDetection}>Restart live detection</button>}<div className="scanner-controls"><input ref={input} hidden type="file" accept="image/*" capture="environment" onChange={e=>{const file=e.target.files?.[0];if(file)void save(file,'image-import');e.currentTarget.value=''}}/><button onClick={()=>input.current?.click()} disabled={busy}><ImagePlus/> Import</button><button className="capture" disabled={!stream||busy||cameraStarting} onClick={()=>void capture()} aria-label="Capture document" title="Capture document"><span/></button><button onClick={()=>nav('/library')}><FolderOpen/> Library</button></div></main>
}

function findDoc(items:LibraryItem[],id:string){return items.find(x=>x.document.id===id)}
function CropEditor({page,onDone,onCancel}:{page:Page;onDone:()=>void;onCancel:()=>void}){
  const image=useRef<HTMLImageElement>(null); const [blob,setBlob]=useState<Blob>(); const [url,setUrl]=useState(''); const [size,setSize]=useState({width:0,height:0}); const [points,setPoints]=useState<Point[]>(); const [active,setActive]=useState<number|null>(null); const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  const fullFrame=(width:number,height:number)=>[{x:0,y:0},{x:width,y:0},{x:width,y:height},{x:0,y:height}];
  useEffect(()=>{let objectUrl='';let cancelled=false;setError('');void storage.blob(page,false).then(value=>{if(cancelled)return;setBlob(value);objectUrl=URL.createObjectURL(value);setUrl(objectUrl)}).catch(cause=>{if(!cancelled)setError(cause instanceof Error?cause.message:'The original page image is unavailable.')});return()=>{cancelled=true;if(objectUrl)URL.revokeObjectURL(objectUrl)}},[page]);
  const onLoad=()=>{const element=image.current;if(!element)return;const width=element.naturalWidth;const height=element.naturalHeight;setSize({width,height});const saved=page.cropQuad&&validCropQuad(page.cropQuad,width,height)?page.cropQuad:undefined;setPoints(saved??fullFrame(width,height))};
  const setPoint=(index:number,next:Point)=>setPoints(current=>current?.map((point,pointIndex)=>pointIndex===index?{x:Math.max(0,Math.min(size.width,next.x)),y:Math.max(0,Math.min(size.height,next.y))}:point));
  const move=(event:React.PointerEvent<HTMLDivElement>)=>{if(active===null||!size.width)return;const rect=image.current?.getBoundingClientRect();if(!rect)return;setPoint(active,{x:(event.clientX-rect.left)/rect.width*size.width,y:(event.clientY-rect.top)/rect.height*size.height})};
  const apply=async()=>{if(!blob||!points||!validCropQuad(points,size.width,size.height)){setError('Place all four corners inside the image and try again.');return}setBusy(true);setError('');try{const cropped=await perspectiveCrop(blob,points);const dimensions=await imageDimensions(cropped);await storage.savePage({...page,width:dimensions.width,height:dimensions.height,filter:'original',cropQuad:undefined,updatedAt:now()},cropped,cropped);onDone()}catch(error){setError(error instanceof Error?error.message:'Could not apply this crop.')}finally{setBusy(false)}};
  const polygon=points?.map(point=>`${point.x/Math.max(1,size.width)*100},${point.y/Math.max(1,size.height)*100}`).join(' ')??'';
  if(error&&!url)return <div className="crop-editor"><p className="crop-error" role="alert">Could not open the crop editor: {error}</p><button className="secondary" onClick={onCancel}>Back to page</button></div>;
  return <div className="crop-editor"><p id="crop-help">Drag a corner to the page edge. With a focused corner, use the arrow keys for fine adjustment.</p><div className="crop-editor-stage" onPointerMove={move} onPointerUp={()=>setActive(null)} onPointerCancel={()=>setActive(null)}><img ref={image} src={url} onLoad={onLoad} onError={()=>setError('The crop image could not be displayed.')} alt="Adjust crop corners"/><svg className="crop-overlay" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points={polygon}/></svg>{points?.map((point,index)=><button key={index} className="crop-handle" style={{left:`${point.x/Math.max(1,size.width)*100}%`,top:`${point.y/Math.max(1,size.height)*100}%`}} onPointerDown={event=>{event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);setActive(index)}} onKeyDown={event=>{const step=event.shiftKey?Math.max(size.width,size.height)*.04:Math.max(size.width,size.height)*.012;const delta=event.key==='ArrowLeft'?{x:-step,y:0}:event.key==='ArrowRight'?{x:step,y:0}:event.key==='ArrowUp'?{x:0,y:-step}:event.key==='ArrowDown'?{x:0,y:step}:undefined;if(delta){event.preventDefault();setPoint(index,{x:point.x+delta.x,y:point.y+delta.y})}}} aria-describedby="crop-help" aria-label={`Move crop corner ${index+1}`} />)}</div><div className="crop-editor-actions"><button className="secondary" onClick={onCancel} disabled={busy}>Cancel</button><button className="primary" onClick={()=>void apply()} disabled={busy||!points}>{busy?<LoaderCircle className="spin"/>:<Check/>} Apply crop</button></div>{error&&<p className="crop-error" role="alert">{error}</p>}</div>}
function Workspace(){
  const {documentId}=useParams(); const {items,loading,error:loadError,refresh}=useLibrary(); const nav=useNavigate();
  const found=documentId?findDoc(items,documentId):undefined; const documentTitle=found?.document.title; const [selected,setSelected]=useState<string>(); const [cropMode,setCropMode]=useState(false); const [titleDraft,setTitleDraft]=useState(''); const [mutating,setMutating]=useState(false); const [mutationError,setMutationError]=useState('');
  const mutationQueue=useRef<Promise<unknown>>(Promise.resolve()); const mutationCount=useRef(0); const titleTimer=useRef<number|undefined>(undefined);
  useEffect(()=>{if(found&&!selected)setSelected(found.pages[0]?.id)},[found,selected]);
  useEffect(()=>{if(documentTitle)setTitleDraft(documentTitle)},[documentTitle]);
  useEffect(()=>()=>{if(titleTimer.current)window.clearTimeout(titleTimer.current)},[]);
  if(loading)return <Shell><p className="loading"><LoaderCircle/> Loading document</p></Shell>;
  if(loadError)return <Shell><main className="action-page"><div className="action-panel"><h1>Could not load this document</h1><p>{loadError}</p><button className="primary" onClick={()=>void refresh()}>Try again</button></div></main></Shell>;
  if(!found)return <Navigate to="/library" replace/>;
  const page=found.pages.find(x=>x.id===selected)??found.pages[0];
  const runMutation=async(operation:()=>Promise<void>)=>{
    mutationCount.current+=1; setMutating(true); setMutationError('');
    const queued=mutationQueue.current.then(operation,operation);
    mutationQueue.current=queued.catch(()=>undefined);
    try{await queued;return true}catch(cause){setMutationError(cause instanceof Error?cause.message:'This change could not be saved.');return false}finally{mutationCount.current-=1;if(mutationCount.current===0)setMutating(false)}
  };
  const mutate=async(changed:Page,filter?:Filter)=>runMutation(async()=>{
    const original=await storage.blob(changed,false); const nextFilter=filter??changed.filter;
    const processed=await processImage(original,nextFilter,changed.rotation);
    const dimensions=await imageDimensions(processed);
    await storage.savePage({...changed,width:dimensions.width,height:dimensions.height,filter:nextFilter,updatedAt:now()},undefined,processed);
    await storage.saveDocument({...found.document,updatedAt:now()}); await refresh();
  });
  const persistTitle=async(value:string)=>{
    const title=value.trim(); if(!title||title===found.document.title)return;
    await runMutation(async()=>{await storage.saveDocument({...found.document,title,updatedAt:now()});await refresh()});
  };
  const updateTitle=(value:string)=>{setTitleDraft(value);if(titleTimer.current)window.clearTimeout(titleTimer.current);titleTimer.current=window.setTimeout(()=>{void persistTitle(value)},500)};
  const commitTitle=()=>{if(titleTimer.current)window.clearTimeout(titleTimer.current);void persistTitle(titleDraft)};
  const rotate=()=>page&&void mutate({...page,rotation:((page.rotation+90)%360) as 0|90|180|270});
  const crop=()=>{if(page&&!mutating)setCropMode(true)};
  const setPageSize=(defaultPageSize:ScanDocument['defaultPageSize'])=>void runMutation(async()=>{await storage.saveDocument({...found.document,defaultPageSize,updatedAt:now()});await refresh()});
  const removePage=async()=>{if(!page||mutating||!confirm('Delete this page?'))return;const pages=found.pages.filter(x=>x.id!==page.id).map((x,i)=>({...x,order:i}));const removed=await runMutation(async()=>{await storage.removePage(page);for(const item of pages)await storage.savePage(item);if(pages.length===0)await storage.remove(found.document.id);else await storage.saveDocument({...found.document,pageIds:pages.map(x=>x.id),updatedAt:now()})});if(!removed)return;if(pages.length===0)nav('/library');else{setSelected(pages[0].id);await refresh()}};
  return <Shell><main className="workspace"><div className="workspace-bar"><Link className="back" to="/library"><ChevronLeft/> Library</Link><input aria-label="Document title" value={titleDraft} onChange={e=>updateTitle(e.target.value)} onBlur={commitTitle} disabled={mutating}/><div><Link className="tool" to={`/document/${found.document.id}/text`}><Type/> Text</Link><Link className="tool" to={`/document/${found.document.id}/export`}><Download/> Export</Link><Link className="tool" to={`/document/${found.document.id}/print`}><Printer/> Print</Link></div></div>{mutating&&<p className="notice" role="status"><LoaderCircle className="spin"/> Saving your change locally...</p>}{mutationError&&<p className="notice" role="alert">{mutationError}</p>}<div className="editor"><aside className="pages"><Link className="add-page" to={`/scan?documentId=${found.document.id}`}><ImagePlus/> Add page</Link>{found.pages.map((item,i)=><button aria-pressed={item.id===page?.id} disabled={mutating} className={item.id===page?.id?'page-thumb selected':'page-thumb'} onClick={()=>setSelected(item.id)} key={item.id}><span>{i+1}</span><FileText/><small>{filterLabel(item.filter)}</small></button>)}</aside><section className="canvas">{page?(cropMode?<CropEditor page={page} onDone={async()=>{setCropMode(false);await refresh()}} onCancel={()=>setCropMode(false)}/>:<PageImage page={page}/>):null}</section><aside className="inspector"><h2>Page {page?found.pages.indexOf(page)+1:0}</h2><label className="page-size">PDF size<select aria-label="PDF page size" disabled={mutating||cropMode} value={found.document.defaultPageSize} onChange={event=>setPageSize(event.target.value as ScanDocument['defaultPageSize'])}><option value="original">Original ratio</option><option value="a4">A4</option><option value="letter">Letter</option><option value="legal">Legal</option></select></label><div className="filter-list">{visibleFilters.map(f=><button aria-pressed={canonicalFilter(page?.filter??'original')===f} disabled={mutating||cropMode} className={canonicalFilter(page?.filter??'original')===f?'active':''} key={f} onClick={()=>page&&void mutate({...page},f)}>{filterLabel(f)}</button>)}</div><button className="secondary" disabled={mutating||cropMode} onClick={rotate}><RotateCw/> Rotate right</button><button className="secondary" disabled={mutating||cropMode} onClick={crop}><Crop/> Adjust crop</button><button className="secondary danger" disabled={mutating||cropMode} onClick={()=>void removePage()}><Trash2/> Delete page</button></aside></div></main></Shell>;
}
function PageImage({page,showShare=true,onReady}:{page:Page;showShare?:boolean;onReady?:()=>void}){
  const [url,setUrl]=useState(''); const [error,setError]=useState(''); const isOriginal=page.filter==='original';
  useEffect(()=>{let u='';let cancelled=false;setUrl('');setError('');void storage.blob(page,!isOriginal).then(blob=>{u=URL.createObjectURL(blob);if(cancelled){URL.revokeObjectURL(u);return}setUrl(u)}).catch(cause=>{if(!cancelled)setError(cause instanceof Error?cause.message:'Stored page image is unavailable.')});return()=>{cancelled=true;if(u)URL.revokeObjectURL(u)}},[page,isOriginal]);
  if(error)return <p className="notice" role="alert">Could not load this page image: {error}</p>;
  return url?<><img className="document-image" src={url} alt="Selected scanned page" onLoad={onReady} style={isOriginal?{transform:`rotate(${page.rotation}deg)`}:undefined}/>{showShare&&<ShareButton page={page}/>}</>:<LoaderCircle className="spin" aria-label="Loading page image"/>;
}
function ShareButton({page}:{page:Page}){
  const {items}=useLibrary(); const record=items.find(item=>item.document.id===page.documentId);
  const [busy,setBusy]=useState(false); const [message,setMessage]=useState('');
  const share=async()=>{
    if(!record)return; setBusy(true); setMessage('');
    const filename=`${record.document.title.replace(/[^a-z0-9-_]+/gi,'-')||'scan'}.pdf`;
    let pdf:Blob|undefined;
    try{
      const {buildPdf}=await import('./services/export');
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
function DocumentAction({kind}:{kind:'text'|'export'|'print'}){
  const {documentId}=useParams();const {items,loading,refresh}=useLibrary();const found=documentId?findDoc(items,documentId):undefined;const documentPages=found?.pages??EMPTY_PAGES;
  const [running,setRunning]=useState(false);const [message,setMessage]=useState('');const [format,setFormat]=useState(kind==='export'?'pdf':'');const [texts,setTexts]=useState<Record<string,string>>({});const [ocrProgress,setOcrProgress]=useState<{page:number;total:number;value:number}>();const [printReady,setPrintReady]=useState(0);
  useEffect(()=>{setTexts(Object.fromEntries(documentPages.map(page=>[page.id,page.text??''])))},[documentPages]);
  useEffect(()=>{setPrintReady(0)},[found?.document.id]);
  if(loading)return <Shell><p className="loading">Loading</p></Shell>;if(!found)return <Navigate to="/library"/>;
  const back=`/document/${found.document.id}`;
  const saveText=async(page:Page,value:string)=>{try{await storage.savePage({...page,text:value,ocrStatus:'complete',ocrPath:'ocr.json',updatedAt:now()});await storage.saveDocument({...found.document,updatedAt:now()});setMessage('Text saved locally.')}catch(cause){setMessage(cause instanceof Error?cause.message:'Could not save the edited text.')}};
  const run=async()=>{setRunning(true);setMessage('');try{if(kind==='print'&&printReady<found.pages.length){setMessage('Wait for every page preview to finish loading before printing.');return}if(kind==='text'){
    const {recognize}=await import('./services/ocr');
    await storage.saveDocument({...found.document,ocrStatus:'partial',updatedAt:now()});
    for(let index=0;index<found.pages.length;index++){
      const page=found.pages[index];setOcrProgress({page:index+1,total:found.pages.length,value:0});
      const blob=await storage.blob(page);const out=await recognize(blob,'eng',value=>setOcrProgress({page:index+1,total:found.pages.length,value}));
      await storage.savePage({...page,text:out.text,ocrStatus:out.confidence<60?'low-confidence':'complete',ocrAverageConfidence:out.confidence,ocrPath:'ocr.json',updatedAt:now()});
      setTexts(current=>({...current,[page.id]:out.text}));
    }
    await storage.saveDocument({...found.document,ocrStatus:'complete',updatedAt:now()});await refresh();setMessage('OCR is complete. Review and edit the recognized text below.');
  }else if(kind==='export'){const {exportFile}=await import('./services/export');await exportFile(found.document,found.pages,format);setMessage('Your export was prepared locally.')}else{window.print();setMessage('The browser opened its system print dialog. LocalScan cannot silently select a printer or print without your confirmation.')}}catch(e){setMessage(e instanceof Error?e.message:'The local operation could not complete.')}finally{setRunning(false);setOcrProgress(undefined)}};
  return <Shell><main className="action-page"><Link className="back" to={back}><ChevronLeft/> Back to document</Link><div className="action-panel"><h1>{kind==='text'?'Recognize and edit text':kind==='export'?'Export document':'Print document'}</h1>{kind==='text'?<><p>OCR runs in a local WebAssembly worker. Language assets are cached by the browser after their first load.</p><button className="primary" disabled={running} onClick={()=>void run()}>{running?<LoaderCircle className="spin"/>:<Type/>} {running?'Recognizing text...':'Run English OCR'}</button>{ocrProgress&&<p className="notice" role="status">Recognizing page {ocrProgress.page} of {ocrProgress.total} ({Math.round(ocrProgress.value*100)}%).</p>}{found.pages.map(p=><textarea key={p.id} aria-label={`Recognized text for page ${p.order+1}`} value={texts[p.id]??''} onChange={e=>setTexts(current=>({...current,[p.id]:e.target.value}))} onBlur={e=>void saveText(p,e.target.value)} placeholder={`Recognized text for page ${p.order+1} will appear here.`}/>)}</>:kind==='export'?<><p>All exports use processed, full-resolution pages  never thumbnails.</p><div className="format-grid">{['pdf','searchable','text-pdf','docx','editable-docx','png','jpeg','webp','zip'].map(x=><button disabled={running} className={format===x?'active':''} onClick={()=>setFormat(x)} key={x}>{x.replaceAll('-',' ')}</button>)}</div><button className="primary" disabled={running||!format} onClick={()=>void run()}>{running?<LoaderCircle className="spin"/>:<Download/>} Export {format.toUpperCase()}</button></>:<><p>Preview is limited to document pages. Your browser controls printer selection and confirmation.</p><div className="print-preview">{found.pages.map(p=><PageImage key={p.id} page={p} showShare={false} onReady={()=>setPrintReady(current=>Math.min(found.pages.length,current+1))}/>)}</div><button className="primary" disabled={running||printReady<found.pages.length} onClick={()=>void run()}><Printer/> {printReady<found.pages.length?'Loading previews...':'Open print dialog'}</button></>}{message&&<p className="notice" role="status">{message}</p>}</div></main></Shell>
}
function SettingsPage(){
  const [usage,setUsage]=useState<{usage?:number;quota?:number}>({});const [persisted,setPersisted]=useState(false);const [message,setMessage]=useState('');const [clearing,setClearing]=useState(false);const [requestingPersistence,setRequestingPersistence]=useState(false);
  const refreshUsage=async()=>{try{setUsage(await storage.estimate());if(navigator.storage?.persisted)setPersisted(await navigator.storage.persisted())}catch(cause){setMessage(cause instanceof Error?cause.message:'Storage details are unavailable in this browser.')}};
  useEffect(()=>{void refreshUsage()},[]);
  const requestPersistence=async()=>{setRequestingPersistence(true);setMessage('');try{const requested=await storage.persist();const confirmed=navigator.storage?.persisted?await navigator.storage.persisted():requested;setPersisted(confirmed);setMessage(confirmed?'Persistent storage is enabled for LocalScan.':'This browser did not grant persistent storage. Your scans still stay local, but browser cleanup may remove them.')}catch(cause){setMessage(cause instanceof Error?cause.message:'Could not request persistent storage.')}finally{setRequestingPersistence(false)}};
  const clearLocal=async()=>{if(!window.confirm('Delete every locally stored document and image? This cannot be undone.'))return;setClearing(true);setMessage('');try{await storage.clear();await refreshUsage();setMessage('Local documents cleared from this browser.')}catch(error){setMessage(error instanceof Error?error.message:'Could not clear local documents.')}finally{setClearing(false)}};
  const used=typeof usage.usage==='number'?`${(usage.usage/1024/1024).toFixed(1)} MB used${typeof usage.quota==='number'?` of ${(usage.quota/1024/1024/1024).toFixed(1)} GB available`:''}`:'Storage estimate unavailable.';
  return <Shell><main className="settings-page"><h1>Storage and privacy</h1><section><ShieldCheck/><div><h2>Stored only on this device</h2><p>LocalScan never uploads scans. Images and document data stay in this browser's private, browser-managed local storage. Clearing this site's browser data can permanently remove them.</p><p className="settings-status">Storage location: {storage.mode()}</p></div></section><section><FileText/><div><h2>Local storage</h2><p>{used}</p><button className="secondary" disabled={persisted||requestingPersistence} onClick={()=>void requestPersistence()}>{persisted?'Persistent storage enabled':requestingPersistence?'Checking browser storage...':'Keep documents available'}</button><button className="secondary danger" disabled={clearing} onClick={()=>void clearLocal()}>{clearing?'Clearing local data…':'Clear all local documents'}</button></div></section><section><MoreHorizontal/><div><h2>Browser support</h2><p>{storage.supported()?'The browser supports OPFS for durable local documents.':'This browser is using IndexedDB for local document storage.'} Camera and printing depend on browser and hardware support.</p></div></section>{message&&<p className="notice" role="status">{message}</p>}</main></Shell>
}
function Help(){return <Shell><main className="help"><h1>How LocalScan handles your documents</h1><p>There is no account, server, remote database, analytics, or document upload. Camera access begins only when you press Enable camera. If automatic scanning is unavailable, import an image or capture manually.</p><p>Printing always uses the system print dialog. Browser security does not allow silent printing or automatic printer selection.</p></main></Shell>}
export default function App(){return <><Routes><Route path="/" element={<Navigate to="/library" replace/>}/><Route path="/library" element={<Library/>}/><Route path="/scan" element={<Scan/>}/><Route path="/scan/:sessionId" element={<Scan/>}/><Route path="/document/:documentId" element={<Workspace/>}/><Route path="/document/:documentId/text" element={<DocumentAction kind="text"/>}/><Route path="/document/:documentId/export" element={<DocumentAction kind="export"/>}/><Route path="/document/:documentId/print" element={<DocumentAction kind="print"/>}/><Route path="/settings" element={<SettingsPage/>}/><Route path="/storage" element={<SettingsPage/>}/><Route path="/help" element={<Help/>}/><Route path="*" element={<Navigate to="/library" replace/>}/></Routes><UpdatePrompt/></>}
