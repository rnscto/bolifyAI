const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout")), 1000));
const success = new Promise(resolve => setTimeout(() => resolve("Success"), 100));
const result = await Promise.race([success, timeout]);
console.log("Result:", result);
// wait 2 seconds to see if Deno crashes
await new Promise(resolve => setTimeout(resolve, 2000));
