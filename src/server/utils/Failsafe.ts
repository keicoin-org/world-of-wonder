/**
 * What answers when a route does not.
 *
 * Express 4 catches a synchronous `throw` out of a handler and hands it to the
 * error middleware. It does not catch a rejection: an `async` handler that
 * rejects, or a `.then` callback that throws, produces a promise nobody is
 * holding, and Node has exited the process over one of those since v15. So a
 * single anonymous request against a handler that dereferences a row the
 * database did not have took this server, every room in it, and the issuer
 * wallet down with it (issue #17).
 *
 * Three things live here, in increasing order of how much they are trusted.
 *
 * `guardRoute` is the fix. It turns a rejection back into an error Express
 * already knows how to handle, which is the only one of the three that answers
 * the request rather than just surviving it.
 *
 * `mountFailsafeResponder` is the far end of that: one place that decides what a
 * failed request looks like from outside. It exists mostly so the answer is a
 * short sentence and not a stack trace — Express's own default error handler
 * writes the stack into the response body whenever `NODE_ENV` is not
 * `production`, and "not production" is how this template is usually run.
 *
 * `keepProcessAlive` is the net, and it is deliberately last. Its job is to be
 * unnecessary. A guard that keeps serving after an unhandled rejection is
 * exactly what Node's default was changed to stop doing, and the reasoning
 * behind that change is sound in general: the code that leaked the rejection did
 * not get to finish, so you do not know what it left behind. What makes it the
 * right trade *here* is the asymmetry of the two failures. Continuing costs one
 * request that never gets an answer, inside a process whose per-request state is
 * a query and a response object. Exiting drops every connected player, every
 * room's unsaved position, and the exchange desk that is watching the issuer
 * account for arrivals — and it takes an operator to bring back. A process that
 * holds this world's mint should not be one dereference away from that, and it
 * should not need every route to be individually perfect in order not to be.
 */

import Logger from "./Logger";

/** Never the caller's; the message may name a table, a path, or a query. */
function describe(reason: unknown): string {
    if (reason instanceof Error) return reason.stack ?? reason.message;
    return String(reason);
}

/**
 * Wrap an async route so a rejection reaches Express instead of the process.
 *
 * Not optional decoration: it is the difference between a 500 and an exit. Note
 * that it works whether or not `mountFailsafeResponder` was called, because
 * Express always has an error handler of its own behind whatever it is given.
 */
export function guardRoute(handler: (request: any, response: any) => unknown) {
    return (request: any, response: any, next: (error?: any) => void): void => {
        try {
            Promise.resolve(handler(request, response)).catch(next);
        } catch (error) {
            next(error);
        }
    };
}

/**
 * The last middleware on the app, and the only one allowed four arguments.
 *
 * Mount it after every route, including the ones a route file adds to `app`
 * itself — Express dispatches error middleware in the order it was added, so one
 * registered too early sees nothing.
 */
export function mountFailsafeResponder(app: any): void {
    app.use((error: any, request: any, response: any, next: (error?: any) => void) => {
        Logger.error(`[failsafe] ${request.method} ${request.originalUrl ?? request.url} failed: ${describe(error)}`);

        // Something already started writing, so the status line is gone and the
        // only honest thing left is to stop talking.
        if (response.headersSent) return next(error);

        // A 4xx that arrived with the error is the client's mistake and keeps its
        // status — `express.json()` tags a malformed body 400, and `res.sendFile`
        // tags a missing file 404. Everything else is ours, and gets a 500 and no
        // detail: the message may name a table, a path, or a query.
        const given = typeof error?.status === "number" ? error.status : error?.statusCode;
        const status = typeof given === "number" && given >= 400 && given < 500 ? given : 500;
        response.status(status).send({
            message: status === 404 ? "Not found." : status === 500 ? "Something went wrong on the server." : "That request could not be read.",
        });
    });
}

/** Injectable so a test can register against something other than the real process. */
export interface ProcessGuardTarget {
    on(event: string, listener: (...args: any[]) => void): unknown;
    exit(code?: number): unknown;
}

/**
 * Log what escaped and, for a rejection, carry on serving.
 *
 * The two events are treated differently on purpose. An unhandled rejection
 * here comes from a promise chain that belongs to one request or one background
 * read, and the rest of the process has not been touched — so it is logged and
 * the server keeps its players. An uncaught exception unwound a real stack from
 * somewhere unknown, which may well have been inside the room loop or the
 * schema encoder, so it is logged through the same transport as everything else
 * (rather than as a bare stderr write nobody is tailing) and then it is still
 * fatal. A supervisor restarting a dead process is a better answer than this
 * one guessing that it is fine.
 */
export function keepProcessAlive(target: ProcessGuardTarget = process): void {
    target.on("unhandledRejection", (reason: unknown) => {
        Logger.error(
            "[failsafe] a promise rejected with nobody holding it — the request it belongs to gets no answer, and the server is staying up: " +
                describe(reason)
        );
    });

    target.on("uncaughtException", (error: unknown) => {
        Logger.error("[failsafe] uncaught exception, exiting: " + describe(error));
        target.exit(1);
    });
}
