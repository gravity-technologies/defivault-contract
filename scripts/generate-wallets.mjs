import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

function parseCount(raw) {
  if (raw === undefined) return 10;

  const count = Number.parseInt(raw, 10);
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error("count must be a positive integer");
  }
  if (count > 1000) {
    throw new Error("count must be 1000 or less");
  }

  return count;
}

function main() {
  const count = parseCount(process.argv[2]);

  console.log(
    "# Store these securely. Anyone with a private key controls the wallet.",
  );
  console.log("# index,address,privateKey");

  for (let index = 0; index < count; index += 1) {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    console.log(`${index + 1},${account.address},${privateKey}`);
  }
}

main();
