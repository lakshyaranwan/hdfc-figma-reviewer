import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AnalysisForm } from "@/components/AnalysisForm";
import { FeedbackDisplay } from "@/components/FeedbackDisplay";
import { Settings, Key } from "lucide-react";
import hdfcLogo from "@/assets/hdfc-logo.png";

export type FeedbackItem = {
  id: string;
  category: "ux" | "ui" | "consistency" | "improvement" | "accessibility" | "design_system" | "high_level";
  title: string;
  description: string;
  severity: "low" | "medium" | "high";
  location?: string;
};

const Index = () => {
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [fileKey, setFileKey] = useState<string>("");
  const [selectedKeyName, setSelectedKeyName] = useState<string | null>(null);
  const [totalKeys, setTotalKeys] = useState<number>(0);
  const navigate = useNavigate();

  useEffect(() => {
    fetchKeyStatus();

    // Set up realtime subscription
    const channel = supabase
      .channel('header-keys-status')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'shared_api_keys'
        },
        () => {
          fetchKeyStatus();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const fetchKeyStatus = async () => {
    try {
      const { data, error } = await supabase
        .from("shared_api_keys")
        .select("*");

      if (error) throw error;
      
      setTotalKeys(data?.length || 0);

      // Check if a key is selected
      const selectedKeyId = localStorage.getItem("hdfc_selected_api_key_id");
      if (selectedKeyId && data) {
        const selectedKey = data.find(k => k.id === selectedKeyId);
        setSelectedKeyName(selectedKey?.user_name || null);
      } else {
        setSelectedKeyName(null);
      }
    } catch (error) {
      console.error("Error fetching key status:", error);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={hdfcLogo} alt="HDFC Logo" className="w-8 h-8 object-contain" />
              <h1 className="text-2xl font-bold text-foreground">HDFC Figma Reviewer</h1>
            </div>
            <div className="flex items-center gap-3">
              {selectedKeyName ? (
                <Badge variant="secondary" className="gap-1">
                  <Key className="h-3 w-3" />
                  {selectedKeyName}'s key
                </Badge>
              ) : totalKeys > 0 ? (
                <Badge variant="outline" className="gap-1">
                  <Key className="h-3 w-3" />
                  {totalKeys} key{totalKeys !== 1 ? 's' : ''} available
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1">
                  <Key className="h-3 w-3" />
                  No keys
                </Badge>
              )}
              <Button variant="ghost" size="sm" onClick={() => navigate("/settings")}>
                <Settings className="h-4 w-4 mr-2" />
                Manage Keys
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-6 py-8 max-w-7xl">
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Analysis Form */}
          <div className="lg:sticky lg:top-24 h-fit">
            <Card className="p-6 shadow-[var(--shadow-card)] hover:shadow-[var(--shadow-hover)] transition-shadow duration-200">
              <AnalysisForm 
                onAnalysisComplete={setFeedback} 
                isAnalyzing={isAnalyzing} 
                setIsAnalyzing={setIsAnalyzing} 
                onFileKeyExtracted={setFileKey} 
              />
            </Card>
          </div>

          {/* Feedback Display */}
          <div>
            <FeedbackDisplay feedback={feedback} isAnalyzing={isAnalyzing} fileKey={fileKey} />
          </div>
        </div>
      </main>
    </div>
  );
};

export default Index;
