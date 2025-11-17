import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Eye, EyeOff } from "lucide-react";
import hdfcLogo from "@/assets/hdfc-logo.png";

const STORAGE_KEY = "hdfc_figma_api_key";

const Settings = () => {
  const [figmaApiKey, setFigmaApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    // Load API key from localStorage
    const savedKey = localStorage.getItem(STORAGE_KEY);
    if (savedKey) {
      setFigmaApiKey(savedKey);
    }
  }, []);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();

    if (!figmaApiKey.trim()) {
      toast({
        title: "Validation Error",
        description: "Please enter a Figma API key",
        variant: "destructive",
      });
      return;
    }

    // Save to localStorage
    localStorage.setItem(STORAGE_KEY, figmaApiKey);

    toast({
      title: "Success!",
      description: "Your Figma API key has been saved locally in your browser.",
    });
  };

  const handleClear = () => {
    localStorage.removeItem(STORAGE_KEY);
    setFigmaApiKey("");
    toast({
      title: "Cleared",
      description: "Your Figma API key has been removed.",
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/50 backdrop-blur-sm">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={hdfcLogo} alt="HDFC Logo" className="w-8 h-8 object-contain" />
              <h1 className="text-2xl font-bold text-foreground">Settings</h1>
            </div>
            <Button variant="ghost" onClick={() => navigate("/")}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8 max-w-2xl">
        <Card className="p-6">
          <h2 className="text-xl font-semibold mb-4">Figma API Configuration</h2>
          <p className="text-muted-foreground mb-6">
            Add your Figma API key to analyze your designs. Your key is stored locally in your browser.
          </p>

          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="figma-key">Figma API Key</Label>
              <div className="relative">
                <Input
                  id="figma-key"
                  type={showKey ? "text" : "password"}
                  placeholder="figd_..."
                  value={figmaApiKey}
                  onChange={(e) => setFigmaApiKey(e.target.value)}
                  required
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3"
                  onClick={() => setShowKey(!showKey)}
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                Get your API key from{" "}
                <a
                  href="https://www.figma.com/developers/api#access-tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Figma Settings
                </a>
              </p>
            </div>

            <div className="flex gap-2">
              <Button type="submit">
                Save API Key
              </Button>
              {figmaApiKey && (
                <Button type="button" variant="outline" onClick={handleClear}>
                  Clear
                </Button>
              )}
            </div>
          </form>
        </Card>
      </main>
    </div>
  );
};

export default Settings;
