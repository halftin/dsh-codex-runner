// Synthetic protocol data: verifies preservation/fallback, not real media generation.
export const specialItems=[
  {id:'special-markdown',type:'agentMessage',text:'SPECIAL_MARKDOWN\n# Heading\n```js\nconst value = "中文🧪";\n```'},
  {id:'special-image',type:'imageGeneration',url:'https://example.invalid/fixture.png',mimeType:'image/png',alt:'SPECIAL_IMAGE'},
  {id:'special-audio',type:'audio',url:'https://example.invalid/fixture.wav',mimeType:'audio/wav',transcript:'SPECIAL_AUDIO'},
  {id:'special-file',type:'file',uri:'file:///fixture/report.txt',mimeType:'text/plain',name:'SPECIAL_FILE.txt'},
  {id:'special-widget',type:'unknownInteractiveWidget',html:'<iframe src="https://example.invalid/"></iframe><script>globalThis.RUNNER_UNSAFE=true</script>',actions:[{id:'submit',label:'SPECIAL_WIDGET'}]},
  {id:'special-large',type:'futureResource',text:'SPECIAL_LARGE '+ '中文🧪'.repeat(7000)+' FULL_RESOURCE_END'},
];
