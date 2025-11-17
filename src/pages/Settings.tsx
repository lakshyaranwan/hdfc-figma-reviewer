import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ArrowLeft, Eye, EyeOff } from "lucide-react";
import hdfcLogo from "@/assets/hdfc-logo.png";

const Settings = () => {
  const [figmaApiKey, setFigmaApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [showKey, setShowKey] = useState(false);
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    fetchApiKey();
  }, []);

  const fetchApiKey = async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      
      if (!user) {
        navigate("/auth");
        return;
      }

      const { data, error } = await supabase
        .from("user_api_keys")
        .select("figma_api_key")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error && error.code !== "PGRST116") {
        throw error;
      }

      if (data) {
        setFigmaApiKey(data.figma_api_key);
        setHasExistingKey(true);
      }
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to fetch API key",
        variant: "destructive",
      });
    } finally {
      setFetching(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!figmaApiKey.trim()) {
      toast({
        title: "Validation Error",
        description: "Please enter a Figma API key",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      
      if (!user) {
        navigate("/auth");
        return;
      }

      if (hasExistingKey) {
        const { error } = await supabase
          .from("user_api_keys")
          .update({ figma_api_key: figmaApiKey })
          .eq("user_id", user.id);

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("user_api_keys")
          .insert({ user_id: user.id, figma_api_key: figmaApiKey });

        if (error) throw error;
        setHasExistingKey(true);
      }

      toast({
        title: "Success!",
        description: "Your Figma API key has been saved securely.",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to save API key",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/auth");
  };

  if (fetching) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

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
            Add your Figma API key to analyze your designs. Your key is stored securely and never shared.
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

            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {hasExistingKey ? "Update" : "Save"} API Key
            </Button>
          </form>

          <div className="mt-8 pt-8 border-t border-border">
            <h3 className="text-lg font-semibold mb-4">Account</h3>
            <Button variant="destructive" onClick={handleLogout}>
              Logout
            </Button>
          </div>
        </Card>
      </main>
    </div>
  );
};

export default Settings;
