#!/usr/bin/env python3
"""Build a self-contained HTML preview of the actual exported GIFs; no art synthesis."""
from __future__ import annotations
import argparse
import base64
import json
from pathlib import Path


def render(run_dir: Path) -> Path:
    request = json.loads((run_dir / 'pet_request.json').read_text(encoding='utf-8'))
    rows = [dict(name=row['state'], duration=sum(row['durations_ms']), loop=row['loop'],
                 data=base64.b64encode((run_dir / 'gifs' / f"{row['state']}.gif").read_bytes()).decode())
            for row in request['states']]
    template = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>GoodPuppy 动画验收</title>
<style>body{font:16px system-ui;margin:32px;background:#f2f2f2;color:#222}button,select,input{font:inherit;margin:6px;padding:6px}#stage{display:flex;align-items:center;justify-content:center;min-height:300px;background:#fff;border:1px solid #aaa}img{width:var(--size,240px);height:var(--size,240px);object-fit:contain}.mirror{transform:scaleX(-1)}p{max-width:850px;line-height:1.6}</style>
<h1>GoodPuppy 动画验收</h1><p>检查身份、实际位移、循环接缝及状态切换；贴贴时可开启镜像伙伴。这里播放的是导出的 GIF，不代表已通过视觉审查或已安装到项目。</p>
<label>状态 <select id="state"></select></label><button id="replay">重播</button>
<label><input id="transition" type="checkbox">idle → 动作 → idle</label><label><input id="pair" type="checkbox">镜像伙伴</label>
<label>背景 <select id="background"><option value="#fff">浅色</option><option value="#20242b">深色</option><option value="#888">灰色</option></select></label>
<label>尺寸 <select id="size"><option>240</option><option>120</option><option>80</option></select></label>
<div id="stage"></div><p id="info"></p>
<script>
const rows=__ROWS__;const $=id=>document.getElementById(id);let timer,urls=[];
for(const row of rows){const o=document.createElement('option');o.value=row.name;o.textContent=row.name;$('state').append(o)}
function show(row){for(const u of urls)URL.revokeObjectURL(u);urls=[];$('stage').replaceChildren();
for(let i=0;i<($('pair').checked?2:1);i++){const bytes=Uint8Array.from(atob(row.data),c=>c.charCodeAt(0));const u=URL.createObjectURL(new Blob([bytes],{type:'image/gif'}));urls.push(u);const im=new Image();im.alt=row.name;im.src=u;if(i)im.className='mirror';$('stage').append(im)}
$('info').textContent=row.name+' · '+row.duration+'ms · '+(row.loop?'循环':'单次');}
function play(){clearTimeout(timer);const row=rows.find(r=>r.name===$('state').value),idle=rows.find(r=>r.name==='idle');
if($('transition').checked&&row!==idle){show(idle);timer=setTimeout(()=>{show(row);timer=setTimeout(()=>show(idle),row.name==='cuddle'?3000:row.duration)},idle.duration)}else show(row)}
$('state').onchange=play;$('pair').onchange=play;$('transition').onchange=play;$('replay').onclick=play;
$('background').onchange=()=>{$('stage').style.background=$('background').value};$('size').onchange=()=>{$('stage').style.setProperty('--size',$('size').value+'px')};play();
</script></html>'''
    path = run_dir / 'qa' / 'preview.html'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(template.replace('__ROWS__', json.dumps(rows).replace('<', '\\u003c')), encoding='utf-8')
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', required=True)
    args = parser.parse_args()
    print(render(Path(args.run_dir).resolve()))


if __name__ == '__main__':
    main()
