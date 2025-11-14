import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { FeedbackItem } from "@/pages/Index";

type AnalysisFormProps = {
  onAnalysisComplete: (feedback: FeedbackItem[]) => void;
  isAnalyzing: boolean;
  setIsAnalyzing: (value: boolean) => void;
};

export const AnalysisForm = ({ onAnalysisComplete, isAnalyzing, setIsAnalyzing }: AnalysisFormProps) => {
  const [figmaUrl, setFigmaUrl] = useState("");
  const { toast } = useToast();

  const handleAnalyze = async () => {
    if (!figmaUrl.trim()) {
      toast({
        title: "URL Required",
        description: "Please enter a Figma file URL",
        variant: "destructive",
      });
      return;
    }

    // Extract file key from URL
    const fileKeyMatch = figmaUrl.match(/file\/([a-zA-Z0-9]+)/);
    if (!fileKeyMatch) {
      toast({
        title: "Invalid URL",
        description: "Please enter a valid Figma file URL",
        variant: "destructive",
      });
      return;
    }

    setIsAnalyzing(true);
    
    try {
      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analyze-figma`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ fileKey: fileKeyMatch[1] }),
        }
      );

      if (!response.ok) {
        throw new Error("Analysis failed");
      }

      const data = await response.json();
      onAnalysisComplete(data.feedback);
      
      toast({
        title: "Analysis Complete!",
        description: `Found ${data.feedback.length} insights. Comments added to Figma.`,
      });
    } catch (error) {
      console.error("Analysis error:", error);
      toast({
        title: "Analysis Failed",
        description: "Unable to analyze the Figma file. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-2">Start Analysis</h2>
        <p className="text-sm text-muted-foreground">
          Paste your Figma file URL to get AI-powered UX/UI feedback
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="figma-url" className="text-foreground">
            Figma File URL
          </Label>
          <Input
            id="figma-url"
            type="url"
            placeholder="https://www.figma.com/file/..."
            value={figmaUrl}
            onChange={(e) => setFigmaUrl(e.target.value)}
            disabled={isAnalyzing}
            className="bg-background border-border focus:ring-primary"
          />
          <p className="text-xs text-muted-foreground">
            Example: https://www.figma.com/file/abc123/My-Design
          </p>
        </div>

        <Button 
          onClick={handleAnalyze}
          disabled={isAnalyzing}
          className="w-full bg-gradient-to-r from-primary to-primary/90 hover:opacity-90 transition-opacity"
        >
          {isAnalyzing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Analyzing Design...
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              Analyze with AI
            </>
          )}
        </Button>
      </div>

      <div className="pt-4 border-t border-border">
        <h3 className="text-sm font-medium text-foreground mb-2">What we analyze:</h3>
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-accent" />
            User experience flows and interactions
          </li>
          <li className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-primary" />
            Visual consistency and design patterns
          </li>
          <li className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-warning" />
            Accessibility and usability issues
          </li>
          <li className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full bg-accent" />
            Improvement suggestions
          </li>
        </ul>
      </div>
    </div>
  );
};
