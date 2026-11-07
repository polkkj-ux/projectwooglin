// Vercel serverless entry point. It reuses the exact request handler from server.js,
// so the deployed API runs the same routes, validation and covenant engine as the local server.
import {handleRequest} from '../server.js';

// vercel.json rewrites /api/<path> to this function with ?__p=<path>. Vercel normally keeps the
// original URL in req.url; if it hands over /api/index instead, rebuild the original path.
export function restorePath(rawUrl){
 const u=new URL(rawUrl,'http://localhost');
 const p=u.searchParams.get('__p');u.searchParams.delete('__p');
 if(p!==null&&(u.pathname==='/api/index'||u.pathname==='/api'))u.pathname='/api/'+p.replace(/^\/+/,'');
 return u.pathname+u.search;
}
export default function handler(req,res){req.url=restorePath(req.url||'/');return handleRequest(req,res);}
