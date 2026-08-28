import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({viewport:{width:1600,height:1000}});
const pkg = {
  meta:{id:"perf",name:"PERFBENCH",customer:"b",site:"b",ticket:"",engineer:"",description:"",createdAt:Date.now(),updatedAt:Date.now(),archived:false},
  doc:{canvas:{grid:true,snap:true,zoom:1,x:0,y:0},
    nodes:[{id:"n-0",type:"device",position:{x:0,y:0},width:176,height:96,measured:{width:176,height:96},
      data:{label:"A",deviceType:"router",addresses:[],tags:[],locked:false,maintenance:false,showDetails:true}},
      {id:"n-1",type:"device",position:{x:300,y:0},width:176,height:96,measured:{width:176,height:96},
      data:{label:"B",deviceType:"server",addresses:[],tags:[],locked:false,maintenance:false,showDetails:true}}],
    edges:[{id:"e-0",type:"live",source:"n-0",target:"n-1",sourceHandle:"r",targetHandle:"l",
      data:{label:"L",sourcePortLabel:"",targetPortLabel:"",pathType:"smoothstep",direction:"forward",color:"#5b6b7c",width:2,enabled:true,maintenance:false,healthRule:{type:"manual",manualStatus:"healthy"}}}],
    probes:[]}};
await p.addInitScript((x)=>localStorage.setItem("livetopo.projects.v1",JSON.stringify({perf:x})),pkg);
await p.goto("http://localhost:5173/",{waitUntil:"networkidle"});
await p.waitForTimeout(1200);
await p.getByText("PERFBENCH").first().click();
await p.waitForTimeout(3000);
console.log("nodes:",await p.evaluate(()=>document.querySelectorAll(".react-flow__node").length));
console.log("edges:",await p.evaluate(()=>document.querySelectorAll(".react-flow__edge").length));
console.log("LS doc nodes now:",await p.evaluate(()=>JSON.parse(localStorage.getItem("livetopo.projects.v1")).perf.doc.nodes.length));
await b.close();
