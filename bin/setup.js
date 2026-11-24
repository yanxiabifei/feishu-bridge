const readline = require('node:readline');
const paths = require('../src/paths');
const { createSecretStore } = require('../src/secrets');
const { createSetup } = require('../src/setup');

async function main() {
  paths.ensureDirs();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  const setup = createSetup({
    prompt: ask,
    secretStore: createSecretStore({ file: paths.SECRET, log: console }),
    configPath: paths.CONFIG,
    print: (line) => console.log(line),
    log: console,
  });

  let result;
  try {
    result = await setup.run();
  } finally {
    rl.close();
  }

  if (!result.ok) {
    console.log('\n自检没通过。照上面 ❌ 后面的提示改飞书后台，然后重新运行：npm run setup');
    process.exitCode = 1;
    return;
  }
  console.log('\n配置已保存。下一步：npm start');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
