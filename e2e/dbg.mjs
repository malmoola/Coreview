import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:1600,height:1000}});
await p.addInitScript(() => {
  localStorage.setItem("coreview.projects.v1", JSON.stringify({perf:{
    meta:{id:"perf",name:"PERFTEST",customer:"b",site:"b",ticket:"",engineer:"",description:"",createdAt:Date.now(),updatedAt:Date.now(),archived:false},
    doc:{canvas:{grid:true,snap:true,zoom:1,x:0,y:0},nodes:[],edges:[],probes:[]}}}));
});
await p.goto("http://localhost:5173/",{waitUntil:"networkidle"});
await p.waitForTimeout(1500);
console.log("LS after load:", await p.evaluate(()=>Object.keys(JSON.parse(localStorage.getItem("coreview.projects.v1")||"{}"))));
console.log("body text:", (await p.locator("body").innerText()).slice(0,500));
await b.close();
