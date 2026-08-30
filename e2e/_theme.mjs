import { chromium } from "playwright";
const NOW = 1756000000000;
const dev = (id,label,type,x,y,st) => ({ id, type:"device", position:{x,y}, width:176, height:96,
  data:{ label, deviceType:type, tags:[], addresses:[{id:`a${id}`,label:"Mgmt",address:`10.0.${x%250}.${y%250}`,isPrimary:true}],
    locked:false, maintenance:false, showDetails:true }, _st:st });
const nodes = [
  dev("n1","CORE-SW","core-switch",380,60,"healthy"),
  dev("n2","EDGE-FW","firewall",700,60,"warning"),
  dev("n3","ACC-SW-1","access-switch",180,300,"healthy"),
  dev("n4","ACC-SW-2","access-switch",480,300,"down"),
  dev("n5","SRV-DB","server",800,300,"healthy"),
  dev("n6","AP-Lobby","access-point",1060,180,"maintenance"),
  { id:"z1", type:"device", position:{x:120,y:230}, width:640, height:250,
    data:{ label:"Access layer", deviceType:"zone", tags:[], addresses:[], locked:false, maintenance:false, showDetails:true }},
  { id:"note1", type:"note", position:{x:1040,y:380}, width:230, height:120,
    data:{ title:"Change 4821", body:"- [ ] Swap uplink\n- [x] Verify LACP", variant:"change",
      fontSize:12, locked:false }},
];
const link = (id,s,t,sh,th,status,extra={}) => ({ id, source:s, target:t, sourceHandle:sh, targetHandle:th, type:"live",
  data:{ sourcePortLabel:"Gi1/0/1", targetPortLabel:"Gi0/1", label:"", pathType:"smoothstep",
    direction:"forward", width:2, color:"#2fbf6b", enabled:true, maintenance:false,
    healthRule:{type:"manual",manualStatus:status}, ...extra }});
const edges = [
  link("e1","n1","n2","r","l","healthy"),
  link("e2","n1","n3","b","t","healthy"),
  link("e3","n1","n4","b","t","down"),
  link("e4","n2","n5","b","t","warning"),
  link("e5","n2","n6","r","l","healthy",{ colorMode:"fixed", color:"#b76eff", lineStyle:"dashed", endCap:"open-arrow" }),
  link("e6","n3","n4","r","l","healthy"),
  link("e7","n4","n5","r","l","disabled"),
];
const probes = nodes.filter(n=>n._st).map(n=>({ id:`p${n.id}`, projectId:"theme", objectKind:"node",
  objectId:n.id, name:n.data.label, kind:"manual", target:"", intervalSeconds:5, timeoutMs:1000,
  failureThreshold:3, recoveryThreshold:1, enabled:true, maintenance:false, isPrimary:true }));
nodes.forEach(n=>{ delete n._st; });
const project = { meta:{ id:"theme", name:"Contrast check", customer:"Acme", site:"HQ", ticket:"CHG-4821",
  engineer:"", description:"", createdAt:NOW, updatedAt:NOW, archived:false },
  documentVersion:1, document:{ nodes, edges, probes:[], canvas:{} } };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport:{ width:1600, height:1000 } });
await page.addInitScript((p)=>localStorage.setItem("coreview.projects.v1", JSON.stringify({[p.meta.id]:p})), project);
await page.goto("http://localhost:5173/", { waitUntil:"networkidle" });
await page.locator(".cv-project-open").first().click();
await page.waitForSelector(".react-flow__node");
await page.locator("label", { hasText:"Reduce motion" }).locator("input").check();
await page.waitForTimeout(1200);
await page.mouse.move(1560,60); await page.waitForTimeout(300);
const out = process.argv[2];
await page.screenshot({ path:`${out}/theme-dark.png`, clip:{x:0,y:0,width:1600,height:720} });
await page.locator("button", { hasText:"White background" }).first().click();
await page.waitForTimeout(800);
await page.mouse.move(1560,60); await page.waitForTimeout(300);
await page.screenshot({ path:`${out}/theme-light.png`, clip:{x:0,y:0,width:1600,height:720} });
await browser.close();
