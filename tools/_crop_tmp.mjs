import fs from 'fs';
import zlib from 'zlib';

function crc32(buf){let c,t=[];for(let n=0;n<256;n++){c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}
let crc=0xffffffff;for(let i=0;i<buf.length;i++)crc=t[(crc^buf[i])&0xff]^(crc>>>8);return (crc^0xffffffff)>>>0;}

function readPNG(file){
  const b=fs.readFileSync(file); let p=8; let w,h,bd,ct,idat=[];
  while(p<b.length){const len=b.readUInt32BE(p);const type=b.toString('ascii',p+4,p+8);const data=b.subarray(p+8,p+8+len);
    if(type==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);bd=data[8];ct=data[9];}
    if(type==='IDAT')idat.push(data);
    if(type==='IEND')break; p+=12+len;}
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const ch=ct===6?4:ct===2?3:ct===0?1:0;
  if(bd!==8||!ch)throw new Error('unsupported bd='+bd+' ct='+ct);
  const stride=w*ch; const out=Buffer.alloc(h*stride);
  let pos=0;
  for(let y=0;y<h;y++){const f=raw[pos++];const line=raw.subarray(pos,pos+stride);pos+=stride;
    const o=y*stride; const prev=(y>0)?out.subarray((y-1)*stride,y*stride):null;
    for(let i=0;i<stride;i++){const a=i>=ch?out[o+i-ch]:0;const bU=prev?prev[i]:0;const c=(i>=ch&&prev)?prev[i-ch]:0;let v=line[i];
      switch(f){case 0:break;case 1:v+=a;break;case 2:v+=bU;break;case 3:v+=(a+bU)>>1;break;
        case 4:{const pp=a+bU-c,pa=Math.abs(pp-a),pb=Math.abs(pp-bU),pc=Math.abs(pp-c);v+=(pa<=pb&&pa<=pc)?a:(pb<=pc?bU:c);break;}}
      out[o+i]=v&255;}}
  return {w,h,ch,px:out};
}
function writePNG(file,w,h,ch,px){
  const stride=w*ch; const raw=Buffer.alloc(h*(stride+1));
  for(let y=0;y<h;y++){raw[y*(stride+1)]=0;px.copy(raw,y*(stride+1)+1,y*stride,(y+1)*stride);}
  const comp=zlib.deflateSync(raw,{level:6});
  const chunks=[Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])];
  const mk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type,'ascii'),data]);const c=Buffer.alloc(4);c.writeUInt32BE(crc32(td));return Buffer.concat([len,td,c]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=ch===4?6:2;
  chunks.push(mk('IHDR',ihdr),mk('IDAT',comp),mk('IEND',Buffer.alloc(0)));
  fs.writeFileSync(file,Buffer.concat(chunks));
}
const [src,x,y,w,h,z,out]=process.argv.slice(2);
const img=readPNG(src);
const X=+x,Y=+y,W=+w,H=+h,Z=+z, OW=Math.round(W*Z), OH=Math.round(H*Z);
const dst=Buffer.alloc(OW*OH*img.ch);
for(let j=0;j<OH;j++)for(let i=0;i<OW;i++){
  const sx=Math.min(img.w-1,X+Math.floor(i/Z)), sy=Math.min(img.h-1,Y+Math.floor(j/Z));
  const s=(sy*img.w+sx)*img.ch, d=(j*OW+i)*img.ch;
  for(let c=0;c<img.ch;c++)dst[d+c]=img.px[s+c];
}
writePNG(out,OW,OH,img.ch,dst);
console.log('wrote',out,OW+'x'+OH,'src',img.w+'x'+img.h,'ch'+img.ch);
