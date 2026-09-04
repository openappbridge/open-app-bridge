# Server-configuration skeletons

These files demonstrate the exact OAB routes and required response headers.
They are not a deployable receiver by themselves. The filenames referenced by
the rules (`index.html`, `detached-helper.html`, `oab-callback.html`, and the
contents of `oab-resources/`) are application-supplied, production build
outputs.

Before enabling discovery, a deployment must:

1. build all three restricted Documents;
2. place every transitive bootstrap, module, stylesheet, font, image, and other
   dependency exclusively in the declared `/_oab/resources/` authority graph
   (or maintain an explicit equivalent inventory);
3. apply the shown security headers to the exact routes and every resource;
4. prove that no service-worker fetch handler intercepts any request in that
   graph; and
5. run the browser conformance matrix against the final deployed bytes.

Do not advertise OAB by publishing the discovery document until those steps
pass. Copying only these rules is insufficient.
