// This is the main plugin code that runs in Figma's sandbox

// Show the plugin UI
figma.showUI(__html__, { width: 450, height: 600 });

// Get current file info
function getFileInfo() {
  const fileKey = figma.fileKey;
  const currentPage = figma.currentPage;
  const selection = figma.currentPage.selection;
  
  let nodeId: string | null = null;
  if (selection.length > 0) {
    nodeId = selection[0].id;
  }
  
  return {
    fileKey,
    pageName: currentPage.name,
    nodeId,
    selectionCount: selection.length,
    fileName: figma.root.name
  };
}

// Send initial file info to UI
figma.ui.postMessage({
  type: 'file-info',
  data: getFileInfo()
});

// Listen for selection changes
figma.on('selectionchange', () => {
  figma.ui.postMessage({
    type: 'file-info',
    data: getFileInfo()
  });
});

// Handle messages from UI
figma.ui.onmessage = async (msg) => {
  if (msg.type === 'get-file-info') {
    figma.ui.postMessage({
      type: 'file-info',
      data: getFileInfo()
    });
  }
  
  if (msg.type === 'post-comment') {
    // Comments are posted via API from UI, just show notification
    figma.notify(`Comment posted: ${msg.text.substring(0, 50)}...`);
  }
  
  if (msg.type === 'analysis-complete') {
    figma.notify('Analysis complete! Review feedback below.');
  }
  
  if (msg.type === 'close') {
    figma.closePlugin();
  }
  
  if (msg.type === 'notify') {
    figma.notify(msg.message);
  }
};
