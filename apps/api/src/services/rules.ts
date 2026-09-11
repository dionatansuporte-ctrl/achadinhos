export function matchesRules(product:any, rules:any={}){
  if(rules.marketplace && rules.marketplace!=='TODOS' && product.marketplace!==rules.marketplace) return false;
  if(typeof rules.minDiscount==='number' && (product.discountPercent||0)<rules.minDiscount) return false;
  if(typeof rules.maxPrice==='number' && product.price && Number(product.price)>rules.maxPrice) return false;
  if(Array.isArray(rules.keywords) && rules.keywords.length){const text=product.title.toLowerCase(); if(!rules.keywords.some((k:string)=>text.includes(k.toLowerCase()))) return false;}
  return true;
}
