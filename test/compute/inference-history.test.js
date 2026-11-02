const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { snapshot, ownerFilter, recordRequest } = require('../../src/utils/inference-history');
const Product = require('../../src/models/Product');
const History = require('../../src/models/InferenceRequest');
const { computeUsageCost } = require('../../src/utils/provider-resolve');
const { sellPricing } = require('../../src/data/runpod-marketplace-products');
const undo=[]; function stub(o,k,v){undo.push([o,k,o[k]]);o[k]=v} afterEach(()=>{while(undo.length){const[o,k,v]=undo.pop();o[k]=v}});
test('history always belongs to the authenticated owner, including admins',()=>{
 assert.deepEqual(ownerFilter({_id:'alice',role:'admin'},{owner:'bob',product:'p'}),{owner:'alice',product:'p'});
});
test('history redacts secrets and binary data and bounds long payloads',()=>{
 const x=snapshot({apiKey:'secret',nested:{Authorization:'private',voice_base64:'abcdef'},max_tokens:4096,prompt:'x'.repeat(200000)});
 assert.equal(x.apiKey,'[redacted]');assert.equal(x.nested.Authorization,'[redacted]');assert.equal(x.nested.voice_base64,'[binary omitted]');assert.equal(x.max_tokens,4096);assert.ok(JSON.stringify(x).length<125000);
});
test('successful and failed requests are recorded with the server owner',async()=>{
 stub(Product,'findOne',()=>({select:()=>({lean:async()=>({_id:'p',slug:'aim-glm-5.3'})})}));
 stub(History,'create',async r=>{assert.equal(r.owner,'alice');return{_id:'aaaaaaaaaaaaaaaaaaaaaaaa'}});
 let update;stub(History,'updateOne',async(q,u)=>{assert.equal(q.owner,'alice');update=u.$set;});
 let sent;const res={statusCode:200,json:b=>{sent=b},once:()=>{},destroyed:false};
 await recordRequest({user:{_id:'alice'},body:{productSlug:'aim-glm-5.3',input:{prompt:'Hi'}},params:{}},res,()=>{});
 await res.json({cost:0.000041,executionTime:1200,delayTime:93,usage:{input_tokens:17,output_tokens:3}});
 assert.equal(update.status,'COMPLETED');assert.equal(update.delayMs,93);assert.equal(update.executionMs,1200);assert.equal(sent.requestLogId,'aaaaaaaaaaaaaaaaaaaaaaaa');
});
test('GLM price is exactly twice upstream and does not reuse the global markup',()=>{
 const ep=require('../../src/data/runpod-public-endpoints.json').find(x=>x.slug==='glm-5.3'); const pricing=sellPricing(ep);
 assert.equal(pricing.inputRate,1.54);assert.equal(pricing.outputRate,4.84);assert.equal(pricing.cachedInputRate,0.286);
 assert.equal(computeUsageCost({category:'inference',pricing},{input_tokens:17,output_tokens:3},{},{upstream:0.00002035}),0.000041);
 assert.equal(computeUsageCost({category:'inference',pricing},{input_tokens:0,output_tokens:0},{},{}),0);
});
