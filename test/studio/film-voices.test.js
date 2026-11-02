const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Product = require('../../src/models/Product');
const drm = require('../../src/utils/content-drm');
const audio = require('../../src/utils/voice-audio');
const minio = require('../../src/config/minio');
const voices = require('../../src/utils/film-voices');
const undo = [];
function stub(o,k,f) { undo.push([o,k,o[k]]); o[k]=f; }
afterEach(() => { while (undo.length) { const [o,k,v]=undo.pop(); o[k]=v; } });
const id='aaaaaaaaaaaaaaaaaaaaaaaa', user={_id:'buyer'};
function product(over={}) { return {_id:id,creator:'seller',category:'voice-clone',published:true,moderationStatus:'active',contentMeta:{cloneStatus:'ready',voiceSampleUrl:'https://cdn.example/ref.wav',voiceModes:['tts']},...over}; }
const scene={narration:'Xin chào',voice:'Binh',voiceSource:'marketplace',voiceProductId:id};
test('unpublished, unready, blocked and STT-only clones cannot be used', () => {
 assert.equal(voices.usable(product()),true);
 for(const p of [product({published:false}),product({moderationStatus:'blocked'}),product({contentMeta:{cloneStatus:'pending'}}),product({contentMeta:{cloneStatus:'ready',voiceSampleUrl:'https://x',voiceModes:['stt']}})]) assert.equal(voices.usable(p),false);
});
test('a buyer-bound license is checked before the seller reference is retrieved', async()=>{
 stub(Product,'findById',()=>({lean:async()=>product()}));stub(drm,'findActiveLicense',async b=>{assert.equal(b.buyerId,'buyer');return null;});stub(audio,'fetchMp3Buffer',()=>{throw Error('Must not fetch');});
 await assert.rejects(voices.narration({lang:'vi'},scene,user,{}),{code:'VOICE_LICENSE_REQUIRED',status:402});
});
test('licensed references are deduplicated; listing owners can use their own voice',async()=>{
 stub(Product,'findById',()=>({lean:async()=>product()}));stub(drm,'findActiveLicense',async()=>({status:'active'}));let calls=0;stub(audio,'fetchMp3Buffer',async()=>{calls++;return{buffer:Buffer.alloc(100,1)};});const refs={};const n=await voices.narration({lang:'vi'},scene,user,refs);await voices.narration({lang:'vi'},scene,{_id:'seller'},refs);assert.equal(calls,1);assert.equal(n.voiceReference,'product_'+id);assert.equal(Object.keys(refs).length,1);
});
test('uploaded references must be ready audio in this project and 6–15 seconds',async()=>{
 const s={...scene,voiceSource:'upload',voiceUploadId:'u'};
 for(const uploads of [[],[{uid:'u',kind:'audio',status:'pending',duration:10}],[{uid:'u',kind:'audio',status:'ready',duration:16}]]) await assert.rejects(voices.narration({lang:'vi',uploads},s,user,{}),{code:'VOICE_SAMPLE_INVALID'});
 stub(minio,'presignFilmGet',async()=> 'https://cdn.example/private');stub(audio,'fetchMp3Buffer',async()=>({buffer:Buffer.alloc(100)}));const n=await voices.narration({lang:'en',uploads:[{uid:'u',kind:'audio',status:'ready',duration:10,size:100,key:'private'}]},s,user,{});assert.equal(n.lang,'en');assert.equal(n.voiceReference,'upload_u');
});
test('preset voices remain unchanged; unsupported seller languages are rejected',async()=>{
 assert.equal((await voices.narration({lang:'vi'},{...scene,voiceSource:'preset'},user,{})).voice,'Binh');stub(Product,'findById',()=>({lean:async()=>product({contentMeta:{...product().contentMeta,voiceLanguages:['en']}})}));await assert.rejects(voices.narration({lang:'vi'},scene,user,{}),{code:'VOICE_LANGUAGE_UNSUPPORTED'});
});
