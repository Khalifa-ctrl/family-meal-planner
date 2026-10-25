// merge.js <store> <rawfile.json>  — rawfile: {key:[{name,price,sizeText,oos,url}]}; scores & writes data/prices.json
const fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..');const catalog=JSON.parse(fs.readFileSync(path.join(ROOT,'data/catalog.json'),'utf8'));
const OUT=path.join(ROOT,'data/prices.json');
const [store,file]=process.argv.slice(2);const raw=JSON.parse(fs.readFileSync(file,'utf8'));
function parseSize(text){const t=text.toLowerCase().replace(/,/g,'');let m;
 if((m=t.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g|ml|l|ltr|litre)\b/)))return normUnit(+m[1]*+m[2],m[3]);
 if((m=t.match(/(\d+(?:\.\d+)?)\s*(kg|g|gm|gr|ml|l|ltr|litre|liter)\b/)))return normUnit(+m[1],m[2]);
 if((m=t.match(/(\d+)\s*(pcs|pieces|pc|eggs)\b/)))return {qty:+m[1],unit:'pc'};return null}
function normUnit(v,u){if(u==='kg')return{qty:v,unit:'kg'};if(['g','gm','gr'].includes(u))return{qty:v/1000,unit:'kg'};if(['l','ltr','litre','liter'].includes(u))return{qty:v,unit:'l'};if(u==='ml')return{qty:v/1000,unit:'l'};return null}
function score(item,p){const n=p.name.toLowerCase();if(item.must.length&&!item.must.some(w=>n.includes(w)))return -1;if(item.ban.some(w=>n.includes(w)))return -1;if(item.need&&!item.need.every(w=>n.includes(w)))return -1;if(item.any&&!item.any.some(w=>n.includes(w)))return -1;let s=1;item.prefer.forEach(w=>{if(n.includes(w))s+=1});if(p.oos)s-=5;return s}
const prev=fs.existsSync(OUT)?JSON.parse(fs.readFileSync(OUT,'utf8')):{items:{}};
const now=new Date().toISOString();const res={updatedAt:now,area:'الرقايب، عجمان',stores:prev.stores||{},items:prev.items||{},errors:[]};
let ok=0,found=0;
for(const item of catalog.items){const list=(raw[item.key]||[]).map(p=>{const size=parseSize(p.name+' '+(p.sizeText||''));p.size=size;if(size&&size.qty>0){p.unitPrice=+(p.price/size.qty).toFixed(2);p.unitLabel=size.unit==='kg'?'د/كغ':size.unit==='l'?'د/لتر':'د/حبة'}p.score=score(item,p);return p}).filter(p=>p.score>0).sort((a,b)=>b.score-a.score||(a.unitPrice??a.price)-(b.unitPrice??b.price));
 res.items[item.key]=res.items[item.key]||{};res.items[item.key][store]={checked:now,found:(raw[item.key]||[]).length,best:list[0]||null,alt:list.slice(1,4)};if(list[0])found++;ok++}
res.stores[store]={ok,found,checked:now};
fs.writeFileSync(OUT,JSON.stringify(res,null,1));console.log(store,'keys',ok,'with price',found);
