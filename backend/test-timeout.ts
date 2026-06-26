const timeout = (ms: number) => new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms));
const result = await Promise.race([
  new Promise(resolve => setTimeout(() => resolve("Success"), 2000)),
  timeout(1000)
]).catch(e => e.message);
console.log(result);
