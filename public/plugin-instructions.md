# HDFC Design Reviewer - Figma Plugin

## Installation

1. Download and unzip the plugin files
2. Open Figma Desktop
3. Go to **Plugins** → **Development** → **Import plugin from manifest**
4. Navigate to the unzipped folder and select `manifest.json`
5. The plugin will appear in your Development plugins

## Usage

1. Select a frame or component in Figma
2. Run the plugin from **Plugins** → **Development** → **Design Analyzer**
3. Choose analysis categories or write a custom prompt
4. Click "Analyze Design" to get AI feedback
5. Use "Drop Comment" to add feedback as sticky notes
6. Use "Apply" to auto-fix simple issues (padding, spacing, etc.)

## Building from Source

If you have the source code:

```bash
cd figma-plugin
npm install
npm run build
```

Then import the `manifest.json` from the `figma-plugin` folder.
