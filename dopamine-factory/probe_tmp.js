console.log('ARGV:', JSON.stringify(process.argv));
console.log('SLICE:', JSON.stringify(String(process.argv[1]).slice(-9)));
console.log('MATCH:', String(process.argv[1]).slice(-9) === 'board.js');
