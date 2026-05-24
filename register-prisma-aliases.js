const path = require('path');

const root = path.join(__dirname, 'dist', 'src');
const runtime = path.join(__dirname, 'node_modules', '@prisma', 'client', 'runtime');

require('module-alias').addAlias('@prisma/client', path.join(root, 'prisma', 'client'));
require('module-alias').addAlias('@prisma/client/runtime', runtime);
