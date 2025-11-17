import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Trash2, Check } from "lucide-react";
import hdfcLogo from "@/assets/hdfc-logo.png";

const STORAGE_KEY = "hdfc_selected_api_key_id";

type SharedApiKey = {
  id: string;
  user_name: string;
  figma_api_key: string;
  created_at: string;
};

const Settings = () => {
  const [userName, setUserName] = useState("");
  const [figmaApiKey, setFigmaApiKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [sharedKeys, setSharedKeys] = useState<SharedApiKey[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    fetchSharedKeys();
    
    // Load selected key from localStorage
    const savedKeyId = localStorage.getItem(STORAGE_KEY);
    if (savedKeyId) {
      setSelectedKeyId(savedKeyId);
    }

    // Set up realtime subscription
    const channel = supabase
      .channel('shared-api-keys-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'shared_api_keys'
        },
        () => {
          fetchSharedKeys();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const fetchSharedKeys = async () => {
    try {
      const { data, error } = await supabase
        .from("shared_api_keys")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setSharedKeys(data || []);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to fetch shared API keys",
        variant: "destructive",
      });
    }
  };

  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!userName.trim() || !figmaApiKey.trim()) {
      toast({
        title: "Validation Error",
        description: "Please enter both your name and Figma API key",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);

    try {
      const { error } = await supabase
        .from("shared_api_keys")
        .insert({
          user_name: userName,
          figma_api_key: figmaApiKey,
        });

      if (error) throw error;

      toast({
        title: "Success!",
        description: "Your API key has been added to the shared pool.",
      });

      setUserName("");
      setFigmaApiKey("");
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to add API key",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteKey = async (id: string) => {
    try {
      const { error } = await supabase
        .from("shared_api_keys")
        .delete()
        .eq("id", id);

      if (error) throw error;

      // If deleted key was selected, clear selection
      if (selectedKeyId === id) {
        setSelectedKeyId(null);
        localStorage.removeItem(STORAGE_KEY);
      }

      toast({
        title: "Deleted",
        description: "API key has been removed.",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to delete API key",
        variant: "destructive",
      });
    }
  };

  const handleSelectKey = (key: SharedApiKey) => {
    setSelectedKeyId(key.id);
    localStorage.setItem(STORAGE_KEY, key.id);
    localStorage.setItem("hdfc_figma_api_key", key.figma_api_key);
    toast({
      title: "Selected",
      description: `Now using ${key.user_name}'s API key`,
    });
  };

  const maskApiKey = (key: string) => {
    if (key.length <= 8) return key;
    return key.substring(0, 4) + "•".repeat(key.length - 8) + key.substring(key.length - 4);
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/50 backdrop-blur-sm">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={hdfcLogo} alt="HDFC Logo" className="w-8 h-8 object-contain" />
              <h1 className="text-2xl font-bold text-foreground">Shared API Keys</h1>
            </div>
            <Button variant="ghost" onClick={() => navigate("/")}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-8 max-w-4xl">
        <Card className="p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">Add Your API Key</h2>
          <p className="text-muted-foreground mb-6">
            Share your Figma API key with the team. All keys are visible to everyone.
          </p>

          <form onSubmit={handleAddKey} className="space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="user-name">Your Name</Label>
                <Input
                  id="user-name"
                  type="text"
                  placeholder="John Doe"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="figma-key">Figma API Key</Label>
                <Input
                  id="figma-key"
                  type="text"
                  placeholder="figd_..."
                  value={figmaApiKey}
                  onChange={(e) => setFigmaApiKey(e.target.value)}
                  required
                />
              </div>
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
            <Button type="submit" disabled={loading}>
              Add API Key
            </Button>
          </form>
        </Card>

        <Card className="p-6">
          <h2 className="text-xl font-semibold mb-4">Shared API Keys ({sharedKeys.length})</h2>
          <p className="text-muted-foreground mb-4">
            Select an API key to use for analysis. Anyone can delete any key.
          </p>

          {sharedKeys.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No API keys added yet. Be the first to add one!
            </div>
          ) : (
            <div className="space-y-3">
              {sharedKeys.map((key) => (
                <div
                  key={key.id}
                  className={`flex items-center justify-between p-4 rounded-lg border transition-colors ${
                    selectedKeyId === key.id
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  }`}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{key.user_name}</p>
                      {selectedKeyId === key.id && (
                        <Check className="h-4 w-4 text-primary" />
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground font-mono">
                      {maskApiKey(key.figma_api_key)}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Added {new Date(key.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {selectedKeyId !== key.id && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleSelectKey(key)}
                      >
                        Select
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteKey(key.id)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </main>
    </div>
  );
};

export default Settings;
