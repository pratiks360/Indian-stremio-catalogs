'use strict';

const { findWorkingProxy } = require('../lib/proxy');

// Trivial, unblocked target — isolates "is any free proxy alive and
// forwarding traffic at all" from "does SonyLIV/CloudFront block them too".
(async () => {
  const dispatcher = await findWorkingProxy(
    'http://httpbin.org/ip',
    (status, body) => status === 200 && body.includes('origin'),
    40
  );
  console.log(dispatcher ? '\nFOUND a working proxy for a trivial target.' : '\nNO working proxy even for a trivial target.');
})();
