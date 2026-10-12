import { desc } from "drizzle-orm"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import { Database } from "@opencode-ai/core/database/database"
import {
  MemoryFactTable,
  MemoryItemTable,
  MemoryRelationTable,
} from "@opencode-ai/core/session/sql"
import { Filesystem } from "@/util/filesystem"
import { UI } from "../ui"

const KIND_COLORS: Record<string, string> = {
  fact: "#38bdf8",
  lesson: "#a78bfa",
  skill: "#34d399",
  tool: "#fbbf24",
  plugin: "#f472b6",
  experience: "#fb7185",
  session: "#94a3b8",
}

export const MemoryGraphCommand = effectCmd({
  command: "graph",
  describe: "export memory knowledge graph as a standalone HTML file",
  builder: (yargs) =>
    yargs
      .option("out", {
        describe: "output HTML file path",
        type: "string",
        default: "memory-graph.html",
      })
      .option("limit", {
        describe: "max facts to include",
        type: "number",
        default: 300,
      }),
  handler: Effect.fn("Cli.memory.graph")(function* (args) {
    const { db } = yield* Database.Service
    const facts = yield* db
      .select()
      .from(MemoryFactTable)
      .orderBy(desc(MemoryFactTable.time_created))
      .all()
      .pipe(Effect.orDie)
    const items = yield* db
      .select()
      .from(MemoryItemTable)
      .orderBy(desc(MemoryItemTable.time_created))
      .all()
      .pipe(Effect.orDie)
    const relations = yield* db
      .select()
      .from(MemoryRelationTable)
      .all()
      .pipe(Effect.orDie)
    const sliced = [...facts.slice(0, args.limit), ...items.filter((i) => i.status !== "deleted").slice(0, args.limit)]
    const nodes: { id: string; label: string; kind: string; color: string; size: number; fact: string }[] = []
    const edges: { a: number; b: number }[] = []
    const topicIndex = new Map<string, number>()
    const byId = new Map<string, number>()
    sliced.forEach((f, i) => {
      byId.set(f.id, i)
      const isItem = "claim" in f
      const text_ = isItem ? f.claim : f.fact
      const status = isItem ? f.status : "active"
      const baseColor = KIND_COLORS[f.kind || "fact"] || "#38bdf8"
      const color = status === "superseded" ? "#475569" : baseColor
      nodes.push({
        id: f.id,
        label: (f.topic || f.kind || "memory").slice(0, 28),
        kind: isItem ? (f.kind || "item") : (f.kind || "fact"),
        color,
        size: 4 + Math.min(10, (f.trust ?? 1) * 6) * (status === "superseded" ? 0.5 : 1),
        fact: text_,
      })
    })
    sliced.forEach((f, i) => {
      const topic = (f.topic || "").trim()
      if (!topic) return
      let ti = topicIndex.get(topic)
      if (ti === undefined) {
        ti = nodes.length
        topicIndex.set(topic, ti)
        nodes.push({ id: "topic:" + topic, label: topic.slice(0, 28), kind: "topic", color: "#f472b6", size: 8, fact: "" })
      }
      edges.push({ a: i, b: ti })
    })
    // Phase 3: draw relation edges (supersedes / related).
    for (const rel of relations) {
      const ai = byId.get(rel.from_id)
      const bi = byId.get(rel.to_id)
      if (ai !== undefined && bi !== undefined) edges.push({ a: ai, b: bi })
    }
    const wordsOf = (id: string) => {
      const f = sliced[byId.get(id) ?? -1]
      if (!f) return new Set<string>()
      const text_ = "claim" in f ? f.claim : f.fact
      return new Set(
        (text_ + " " + (f.topic || "")).toLowerCase().split(/[^a-z0-9-_]+/).filter((w) => w.length > 4),
      )
    }
    for (let i = 0; i < sliced.length; i++) {
      const kwi = wordsOf(sliced[i].id)
      if (kwi.size === 0) continue
      let linked = 0
      for (let j = i + 1; j < sliced.length && linked < 3; j++) {
        const kwj = wordsOf(sliced[j].id)
        let shared = 0
        const iter = kwi.values()
        let w = iter.next()
        while (!w.done) {
          if (kwj.has(w.value)) shared++
          w = iter.next()
        }
        if (shared >= 2) {
          edges.push({ a: i, b: j })
          linked++
        }
      }
    }
    const payload = JSON.stringify({ nodes, edges })
    const headA = "<!DOCTYPE html><html><head><meta charset utf-8><title>Memory Graph</title>"
    const headB = "<style>html,body{margin:0;height:100%;background:#020617;overflow:hidden;font-family:monospace}</style></head><body>"
    const bodyOpen = "<canvas id=c></canvas><div id=panel>click a node</div><script>"
    const jsSetup =
      "var DATA=" + payload + ";" +
      "var cv=document.getElementById(\"c\"),ctx=cv.getContext(\"2d\"),panel=document.getElementById(\"panel\");" +
      "function rs(){cv.width=innerWidth;cv.height=innerHeight}addEventListener(\"resize\",rs);rs();" +
      "var N=DATA.nodes,E=DATA.edges,cx=innerWidth/2,cy=innerHeight/2,scale=1;" +
      "N.forEach(function(n,i){var a=i*2.39996,r=120+60*Math.sqrt(i);n.x=cx+r*Math.cos(a);n.y=cy+r*Math.sin(a);n.vx=0;n.vy=0;});"
    const jsInteract =
      "var drag=null;" +
      "cv.addEventListener(\"mousedown\",function(e){var best=null,bd=1e9;N.forEach(function(n){var dx=(n.x-cx)*scale+cx-e.clientX,dy=(n.y-cy)*scale+cy-e.clientY,d=dx*dx+dy*dy;if(d<bd){bd=d;best=n;}});if(bd<900)drag=best;});" +
      "addEventListener(\"mouseup\",function(){drag=null;});" +
      "addEventListener(\"mousemove\",function(e){if(drag){drag.x=(e.clientX-cx)/scale+cx;drag.y=(e.clientY-cy)/scale+cy;}});" +
      "cv.addEventListener(\"wheel\",function(e){e.preventDefault();scale*=e.deltaY>0?0.9:1.1;scale=Math.min(3,Math.max(.3,scale));},{passive:false});"
    const jsClick =
      "cv.addEventListener(\"click\",function(e){var best=null,bd=1e9;N.forEach(function(n){var dx=(n.x-cx)*scale+cx-e.clientX,dy=(n.y-cy)*scale+cy-e.clientY,d=dx*dx+dy*dy;if(d<bd){bd=d;best=n;}});showBest(best,bd);});" +
      "function showBest(best,bd){if(best){if(bd<2500){panel.textContent=best.label+\" \"+best.kind+\" \"+best.id+\" \"+best.fact;}}}"
    const jsTick =
      "function tick(){for(var k=0;k<2;k++){for(var i=0;i<N.length;i++){for(var j=i+1;j<N.length;j++){var a=N[i],b=N[j],dx=a.x-b.x,dy=a.y-b.y,d2=dx*dx+dy*dy||1,d=Math.sqrt(d2),f=Math.min(900/d2,2);a.vx+=dx/d*f;a.vy+=dy/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f;}}E.forEach(function(e){var a=N[e.a],b=N[e.b],dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1,f=(d-140)*0.004;a.vx+=dx/d*f;a.vy+=dy/d*f;b.vx-=dx/d*f;b.vy-=dy/d*f;});N.forEach(function(n){n.vx*=0.86;n.vy*=0.86;n.x+=n.vx;n.y+=n.vy;});}" +
      "ctx.fillStyle=\"#020617\";ctx.fillRect(0,0,cv.width,cv.height);" +
      "ctx.strokeStyle=\"rgba(8,145,178,.35)\";ctx.lineWidth=1;E.forEach(function(e){var a=N[e.a],b=N[e.b];ctx.beginPath();ctx.moveTo((a.x-cx)*scale+cx,(a.y-cy)*scale+cy);ctx.lineTo((b.x-cx)*scale+cx,(b.y-cy)*scale+cy);ctx.stroke();});" +
      "N.forEach(function(n){var x=(n.x-cx)*scale+cx,y=(n.y-cy)*scale+cy;ctx.shadowBlur=14;ctx.shadowColor=n.color;ctx.fillStyle=n.color;ctx.beginPath();ctx.arc(x,y,n.size*Math.sqrt(scale),0,7);ctx.fill();ctx.shadowBlur=0;ctx.fillStyle=\"#e2e8f0\";ctx.font=\"10px monospace\";ctx.fillText(n.label,x+8,y+3);});" +
      "requestAnimationFrame(tick);}tick();"
    const tail = "</scr" + "ipt></body></html>"
    const html = headA + headB + bodyOpen + "var DATA=" + payload + ";" + jsSetup + jsInteract + jsClick + jsTick + tail
    yield* Effect.tryPromise({
      try: () => Filesystem.write(args.out, html),
      catch: () => new Error("graph write failed"),
    }).pipe(Effect.orDie)
    UI.println(
      UI.Style.TEXT_SUCCESS_BOLD +
        "Graph: " +
        nodes.length +
        " nodes, " +
        edges.length +
        " edges -> " +
        args.out +
        UI.Style.TEXT_NORMAL,
    )
  }),
})
