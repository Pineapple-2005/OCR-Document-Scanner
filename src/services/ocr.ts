import { createWorker } from 'tesseract.js'
export async function recognize(blob:Blob, language:string, progress:(n:number)=>void){ const worker=await createWorker(language,1,{logger:m=>{if(m.status==='recognizing text')progress(m.progress)}}); try {const r=await worker.recognize(blob); return {text:r.data.text, confidence:r.data.confidence}} finally {await worker.terminate()} }
