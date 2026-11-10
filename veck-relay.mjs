// Deploy this module as a Cloudflare Worker if the local machine cannot reach Veck.
export const isVeckHost = hostname =>
    /^(?:(?:files|usa-[1-5]|fra-[1-3]|asia-[1-2])\.)?veck\.io$/.test(hostname);

export function parseURL(value, base) {
    try {
        return new URL(value, base);
    } catch {
        return null;
    }
}

export function upstreamURL(rawURL) {
    const request = parseURL(rawURL, "http://localhost");
    if (!request) return null;
    const match = request.pathname.match(/^\/proxy\/([^/]+)(\/.*)?$/);
    if (!match || !isVeckHost(match[1])) return null;

    const target = new URL(`https://${match[1]}`);
    target.pathname = match[2] || "/";
    target.search = request.search;
    return target;
}

export function relayRedirect(location, upstream, relayOrigin = "") {
    const target = parseURL(location, upstream);
    if (target?.protocol === "https:" && !target.port && isVeckHost(target.hostname)) {
        return `${relayOrigin}/proxy/${target.hostname}${target.pathname}${target.search}${target.hash}`;
    }
    return location;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const target = upstreamURL(url);
        if (!target) return new Response("Unknown relay route", { status: 404 });

        const origin = request.headers.get("Origin");
        if (!env.GAME_ORIGIN || origin !== env.GAME_ORIGIN) {
            return new Response("Game origin is not allowed", { status: 403 });
        }
        const cors = {
            "Access-Control-Allow-Origin": env.GAME_ORIGIN,
            "Access-Control-Allow-Credentials": "true",
            "Vary": "Origin"
        };
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: {
                ...cors,
                "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE",
                "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || ""
            } });
        }

        let upstream;
        try {
            upstream = await fetch(new Request(target, request), { redirect: "manual" });
        } catch {
            return new Response("Veck upstream is unreachable", { status: 502, headers: cors });
        }
        if (upstream.status === 101) return upstream;

        const response = new Response(upstream.body, upstream);
        for (const [name, value] of Object.entries(cors)) {
            if (name === "Vary") response.headers.append(name, value);
            else response.headers.set(name, value);
        }
        const location = response.headers.get("Location");
        if (location) response.headers.set("Location", relayRedirect(location, target, url.origin));
        return response;
    }
};
