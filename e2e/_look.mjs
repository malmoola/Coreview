import { chromium } from "playwright";
const NOW = 1756000000000;
const project = { meta:{ id:"look", name:"Look", customer:"", site:"", ticket:"", engineer:"",
  description:"", createdAt:NOW, updatedAt:NOW, archived:false },
  documentVersion:1, document:{ nodes:[
    { id:"n1", type:"device", position:{x:100,y:80}, width:176, height:96,
      data:{ label:"Firewall", deviceType:"firewall", tags:[],
        addresses:[{id:"a1",label:"Mgmt",address:"192.168.14.1",isPrimary:true}],
        locked:false, maintenance:false, showDetails:true }},
    { id:"n2", type:"device", position:{x:100,y:420}, width:176, height:96,
      data:{ label:"Laundry-SW", deviceType:"access-switch", tags:[],
        addresses:[{id:"a2",label:"Mgmt",address:"192.168.14.112",isPrimary:true}],
        locked:false, maintenance:false, showDetails:true }},
  { id:"s0", type:"device", position:{x:380,y:80}, width:176, height:96,
      data:{ label:"rectangle", deviceType:"rectangle", tags:[], addresses:[], locked:false, maintenance:false, showDetails:true }},
{ id:"s1", type:"device", position:{x:610,y:80}, width:176, height:96,
      data:{ label:"rounded", deviceType:"rounded", tags:[], addresses:[], locked:false, maintenance:false, showDetails:true }},
{ id:"s2", type:"device", position:{x:840,y:80}, width:176, height:96,
      data:{ label:"circle", deviceType:"circle", tags:[], addresses:[], locked:false, maintenance:false, showDetails:true }},
{ id:"s3", type:"device", position:{x:1070,y:80}, width:176, height:96,
      data:{ label:"diamond", deviceType:"diamond", tags:[], addresses:[], locked:false, maintenance:false, showDetails:true }},
{ id:"s4", type:"device", position:{x:1300,y:80}, width:176, height:96,
      data:{ label:"cloud", deviceType:"cloud", tags:[], addresses:[], locked:false, maintenance:false, showDetails:true }},
{ id:"s5", type:"device", position:{x:380,y:300}, width:176, height:96,
      data:{ label:"text", deviceType:"text", tags:[], addresses:[], locked:false, maintenance:false, showDetails:true }},
{ id:"s6", type:"device", position:{x:610,y:300}, width:176, height:96,
      data:{ label:"custom-image", deviceType:"custom-image", tags:[], addresses:[], locked:false, maintenance:false, showDetails:true }},
{ id:"s7", type:"device", position:{x:840,y:300}, width:176, height:96,
      data:{ label:"site", deviceType:"site", tags:[], addresses:[], locked:false, maintenance:false, showDetails:true }},
{ id:"s8", type:"device", position:{x:1070,y:300}, width:176, height:96,
      data:{ label:"private-cloud", deviceType:"private-cloud", tags:[], addresses:[], locked:false, maintenance:false, showDetails:true }},
{ id:"s9", type:"device", position:{x:1300,y:300}, width:176, height:96,
      data:{ label:"internet", deviceType:"internet", tags:[], addresses:[], locked:false, maintenance:false, showDetails:true }}
  ], edges:[{ id:"e1", source:"n1", target:"n2", sourceHandle:"b", targetHandle:"t", type:"live",
    data:{ sourcePortLabel:"Gi1/0/1", targetPortLabel:"Gi0/1", label:"Uplink",
      pathType:"smoothstep", direction:"forward", width:2, color:"#2fbf6b",
      enabled:true, maintenance:false, healthRule:{type:"manual",manualStatus:"healthy"} }}],
    probes:[], canvas:{} } };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport:{ width:1600, height:1000 } });
await page.addInitScript((p)=>localStorage.setItem("coreview.projects.v1", JSON.stringify({[p.meta.id]:p})), project);
await page.goto("http://localhost:5173/", { waitUntil:"networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForSelector(".react-flow__node");
await page.waitForTimeout(900);
const out = process.argv[2];
// The palette, to see which shapes render.
await page.locator(".cv-palette-search, .cv-palette input").first().fill("");
// Scroll the palette to the shapes group so the cloud is in frame.
const group = page.locator(".cv-palette-group", { hasText: "Shapes" }).first();
if (await group.count()) await group.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
const pal = await page.locator(".cv-palette").boundingBox();
if (pal) await page.screenshot({ path:`${out}/palette.png`, clip:{x:pal.x,y:pal.y,width:pal.width,height:Math.min(pal.height,940)} });
const shapeItems = await page.locator(".cv-palette-item").allTextContents();
console.log("palette items:", JSON.stringify(shapeItems));
// The inspector with a link selected, which is the crowded one.
await page.locator(".react-flow__node").first().click();
await page.waitForTimeout(400);
await page.locator(".react-flow__pane").click({ position:{x:60,y:60} });
await page.waitForTimeout(300);
await page.keyboard.press("Control+Shift+ArrowUp").catch(()=>{});
await page.screenshot({ path:`${out}/shapes.png`, clip:{x:340,y:60,width:1200,height:560} });
const insp = await page.locator(".cv-inspector").boundingBox();
if (insp) await page.screenshot({ path:`${out}/inspector.png`, clip:{x:insp.x,y:insp.y,width:insp.width,height:Math.min(insp.height,940)} });
const report = async (what) => {
  const r = await page.locator(".cv-inspector").evaluate((el) => {
    const limit = el.getBoundingClientRect().right;
    const bad = [];
    el.querySelectorAll("*").forEach((n) => {
      const b = n.getBoundingClientRect();
      if (b.width > 0 && b.right > limit + 1) {
        bad.push(`${n.tagName}.${(n.getAttribute("class") ?? "").slice(0, 34)} w=${Math.round(b.width)} over=${Math.round(b.right - limit)}`);
      }
    });
    return { client: el.clientWidth, scroll: el.scrollWidth, worst: bad.slice(0, 8) };
  });
  console.log(what, JSON.stringify(r, null, 1));
};
await report("NODE SELECTED:");
// And with a link selected, which has the most controls.
await page.locator(".react-flow__pane").click({ position:{x:60,y:60} });
await page.waitForTimeout(200);
const d = await page.locator(".react-flow__edge-path").first().getAttribute("d");
const nums = (d ?? "").match(/-?[\d.]+/g)?.map(Number) ?? [];
const t = await page.locator(".react-flow__viewport").evaluate((el)=>{const m=new DOMMatrixReadOnly(getComputedStyle(el).transform);return {a:m.a,e:m.e,f:m.f};});
const pane = await page.locator(".react-flow__pane").boundingBox();
for (let i=2;i+1<nums.length;i+=2){
  const at={x:pane.x+nums[i]*t.a+t.e,y:pane.y+nums[i+1]*t.a+t.f};
  const tag = await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.tagName??"",at);
  if (tag==="path"){ await page.mouse.click(at.x,at.y); break; }
}
await page.waitForTimeout(400);
await report("LINK SELECTED:");
const insp2 = await page.locator(".cv-inspector").boundingBox();
if (insp2) await page.screenshot({ path:`${out}/inspector-link.png`, clip:{x:insp2.x,y:insp2.y,width:insp2.width,height:Math.min(insp2.height,940)} });
await browser.close();
