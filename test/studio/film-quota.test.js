const {test}=require('node:test');const assert=require('node:assert/strict');
const q=require('../../src/utils/film-quota');const Model=require('../../src/models/FilmDailyQuota');
const env={FILM_BACKEND:'own',FILM_FREE_VIDEOS_PER_DAY:'3',FILM_FREE_IMAGES_PER_DAY:'5'};
test('owned mode defaults to no daily giveaways',()=>{assert.equal(q.limits({FILM_BACKEND:'own'}).videos,0);assert.equal(q.limits({FILM_BACKEND:'own'}).images,0);});
test('free video cap is three per day, <=20 seconds; images independent',()=>{
 assert.deepEqual(q.allocation({videos:0,images:0},{seconds:20,images:1},env),{videos:1,images:1});
 assert.deepEqual(q.allocation({videos:3,images:5},{seconds:20,images:1},env),{videos:0,images:0});
 assert.equal(q.allocation({videos:0,images:0},{seconds:21,images:0},env).videos,0);
 assert.equal(q.amount({seconds:20,images:1},{videos:0,images:0},{perSecond:.05,perImage:.01}),1.01);
 assert.equal(q.amount({seconds:20,images:1},{videos:1,images:1},{perSecond:.05,perImage:.01}),0);
});
test('quota day rolls over at midnight UTC+7',()=>{
 assert.notEqual(q.dayId('u',new Date('2026-10-28T16:59:59Z')),q.dayId('u',new Date('2026-10-28T17:00:00Z')));
});
test('parallel reservations cannot exceed caps; failed reservation restored only once',async()=>{
 process.env.FILM_BACKEND='own';process.env.FILM_FREE_VIDEOS_PER_DAY='3';process.env.FILM_FREE_IMAGES_PER_DAY='5';let doc;
 const read=(obj,path)=>path.split('.').reduce((o,k)=>o?.[k],obj);
 const set=(obj,path,v)=>{const a=path.split('.');let o=obj;for(const k of a.slice(0,-1))o=o[k]||(o[k]={});o[a.at(-1)]=v;};
 Model.findById=()=>({lean:async()=>structuredClone(doc)});
 Model.updateOne=async(filter,update,opts)=>{
   if(!doc&&opts?.upsert){doc={_id:filter._id,...update.$setOnInsert};return {modifiedCount:1};}
   if(!Object.entries(filter).every(([k,v])=>read(doc,k)===v))return {modifiedCount:0};
   for(const [k,v]of Object.entries(update.$inc||{}))set(doc,k,(read(doc,k)||0)+v);
   for(const [k,v]of Object.entries(update.$set||{}))set(doc,k,v);
   return {modifiedCount:1};
 };
 const holds=await Promise.all(Array.from({length:8},()=>q.reserve('user',{seconds:20,images:1})));
 assert.equal(holds.reduce((s,h)=>s+h.videos,0),3);assert.equal(holds.reduce((s,h)=>s+h.images,0),5);
 const h=holds.find(h=>h.videos);await q.release(h);await q.release(h);
 assert.equal(doc.videos,2);assert.equal(doc.images,4);
 const again=await q.reserve('user',{seconds:20,images:1});assert.equal(again.videos,1);assert.equal(again.images,1);
 delete process.env.FILM_BACKEND;delete process.env.FILM_FREE_VIDEOS_PER_DAY;delete process.env.FILM_FREE_IMAGES_PER_DAY;
});
