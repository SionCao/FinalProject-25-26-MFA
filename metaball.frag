precision highp float;

#define MAX_CELLS 36

uniform vec2 u_resolution;
uniform float u_time;
uniform int u_count;
uniform vec4 u_cells[MAX_CELLS]; // x,y,r,reaction, normalized screen coords
uniform vec4 u_colors[MAX_CELLS];
uniform float u_aspects[MAX_CELLS];
varying vec2 v_uv;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123); }
float noise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float a=hash(i), b=hash(i+vec2(1,0)), c=hash(i+vec2(0,1)), d=hash(i+vec2(1,1));
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}
float fbm(vec2 p){
  float v=0.0, a=0.5;
  for(int i=0;i<5;i++){ v += a*noise(p); p*=2.03; a*=0.5; }
  return v;
}

void main(){
  vec2 uv = v_uv;
  vec2 px = uv * u_resolution;
  float field = 0.0;
  float local = 0.0;
  float edgeField = 0.0;
  vec3 colorMix = vec3(0.0);
  float weightSum = 0.0;

  for(int i=0;i<MAX_CELLS;i++){
    if(i >= u_count) break;
    vec4 c = u_cells[i];
    vec2 cp = c.xy * u_resolution;
    float r = c.z;
    float aspect = u_aspects[i];
    vec2 d = px - cp;
    d.x /= aspect;

    float dist = length(d);
    float organic = fbm(d/r*2.0 + vec2(u_time*0.08, -u_time*0.06) + float(i)*9.17);
    float warpedDist = dist * (0.95 + organic * 0.10);

    // 局部扩散：只比细胞大一点，不铺满全屏
    float soft = smoothstep(r*1.18, r*0.42, warpedDist);
    float core = smoothstep(r*0.88, r*0.50, warpedDist);
    float rim = smoothstep(r*1.05, r*0.88, warpedDist) - smoothstep(r*0.74, r*0.50, warpedDist);

    float metaball = (r*r) / (warpedDist*warpedDist + r*r*0.95);
    metaball *= smoothstep(r*1.28, r*0.45, warpedDist);

    field += metaball * (0.24 + c.w*0.46);
    local += soft;
    edgeField += rim;

    vec3 cc = u_colors[i].rgb;
    float w = soft * (0.5 + c.w*0.9);
    colorMix += cc * w;
    weightSum += w;
  }

  vec3 base = vec3(0.92, 0.96, 0.92);
  vec3 milk = vec3(0.86, 0.94, 0.91);
  vec3 col = mix(base, milk, 0.28 + 0.10*fbm(uv*6.0 + u_time*0.02));

  if(weightSum > 0.001){
    vec3 dye = colorMix / weightSum;
    float a = clamp(local * 0.10, 0.0, 0.38);
    col = mix(col, dye, a);
  }

  // 融合区域：细胞靠近后出现更明显的乳浊连续组织
  float fusion = smoothstep(0.82, 1.36, field);
  vec3 fusionColor = mix(vec3(0.94,0.88,0.62), vec3(0.62,0.88,0.78), 0.5 + 0.5*sin(u_time*0.25));
  col = mix(col, fusionColor, fusion * 0.24);

  // 柔软边缘，不用硬轮廓
  col += vec3(0.95, 1.0, 0.93) * edgeField * 0.11;

  // 微小颗粒和显微镜背景
  float grain = hash(px + floor(u_time*8.0));
  col += (grain - 0.5) * 0.018;

  float alpha = clamp(local * 0.42 + edgeField * 0.24 + fusion * 0.28, 0.0, 0.58);
  gl_FragColor = vec4(col, alpha);
}
